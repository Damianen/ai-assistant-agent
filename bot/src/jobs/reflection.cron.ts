import cron from "node-cron";
import { logger } from "../lib/logger.js";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { bot } from "../lib/telegram.js";
import { prisma } from "../db/prisma.js";
import { getSchemaAsString } from "../db/schema-registry.js";
import { getGraphStats } from "../db/graph.js";
import { BRAIN_TOOLS, executeTool } from "../services/brain-tools.js";

const anthropic = new Anthropic();
const chatId = process.env.TELEGRAM_CHAT_ID;
const MAX_ROUNDS = 15;

function buildReflectionPrompt(
  schema: string,
  stats: string,
  memories: string,
): string {
  return `You are reviewing your own knowledge graph after one week of operation.
Your job is to make it better — more organised, more consistent, more useful.

Current schema:
${schema}

Graph statistics:
${stats}

Memories from this week:
${memories}

Tasks:
1. Look for node types that overlap in meaning — merge them with merge_nodes
2. Look for RELATED_TO relationships that now deserve a proper type — propose it with propose_schema_addition
3. Identify any obvious connections you haven't made yet
4. Look for duplicate nodes representing the same entity — merge them
5. Propose new types if patterns in the data suggest they're needed

Use your tools. Then write a brief reflection (2-3 sentences) on what you changed and why.`;
}

export async function runWeeklyReflection(): Promise<void> {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [schema, stats, recentMemories] = await Promise.all([
    getSchemaAsString(),
    getGraphStats(),
    prisma.memory.findMany({
      where: { createdAt: { gte: oneWeekAgo } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const memoriesText =
    recentMemories.length > 0
      ? recentMemories
          .map((m) => `[${m.createdAt.toISOString()}] ${m.content}`)
          .join("\n")
      : "No memories recorded this week.";

  const messages: MessageParam[] = [
    {
      role: "user",
      content: buildReflectionPrompt(schema, stats, memoriesText),
    },
  ];

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    tools: BRAIN_TOOLS,
    messages,
  });

  let rounds = 0;
  while (response.stop_reason === "tool_use" && rounds < MAX_ROUNDS) {
    rounds++;

    const toolUseBlocks = response.content.filter(
      (block) => block.type === "tool_use",
    );

    const toolResults: ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        if (block.type !== "tool_use") {
          throw new Error("Unexpected block type in tool_use filter result");
        }
        try {
          const result = await executeTool(
            block.name,
            block.input as Record<string, unknown>,
          );
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result,
          };
        } catch (err) {
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: toolResults as ContentBlockParam[],
    });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      tools: BRAIN_TOOLS,
      messages,
    });
  }

  // Extract final reflection text
  const textBlock = response.content.find((block) => block.type === "text");
  const summary =
    textBlock?.type === "text"
      ? textBlock.text
      : "Reflection completed but produced no summary.";

  // Build a changes log from all tool calls made during the loop
  const changes = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b: any) => b.type === "tool_use")
    .map((b: any) => `${b.name}(${JSON.stringify(b.input)})`)
    .join("\n");

  // Save ReflectionLog to Prisma
  await prisma.reflectionLog.create({
    data: {
      summary,
      changes: changes || "No tool calls made.",
    },
  });

  // Create a Reflection node in FalkorDB
  await executeTool("create_node", {
    type: "Reflection",
    properties: {
      summary,
      date: new Date().toISOString(),
    },
    merge_on: ["date"],
  });

  // Notify via Telegram
  if (chatId) {
    await bot.api.sendMessage(
      chatId,
      `🧠 Weekly reflection complete:\n${summary}`,
    );
  }
}

export const reflectionCron = cron.schedule(
  "0 2 * * 0",
  async () => {
    try {
      await runWeeklyReflection();
    } catch (err) {
      logger.error({ err }, "Weekly reflection failed");
    }
  },
);
