import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getSchemaAsString } from "../db/schema-registry.js";
import { BRAIN_TOOLS, executeTool } from "./brain-tools.js";

const anthropic = new Anthropic();

function buildSystemPrompt(schemaString: string): string {
  return `You are a personal AI assistant with access to a knowledge graph — your memory and brain.
You maintain this graph yourself, creating nodes and relationships to represent everything you learn.

Before responding, always:
1. Call get_schema to see what types you have
2. Call query_graph for any people, places, or concepts mentioned
3. Call create_node and create_relationship to store new information
4. If you need a node or relationship type that doesn't exist, call propose_schema_addition first
5. If the user asks to forget or remove information, call query_graph to find the relevant node(s), then call delete_node to remove them

Be helpful, concise, and personal. Reference what you know about the user when relevant.

Current schema:
${schemaString}`;
}

export async function processWithBrain(
  userMessage: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<string> {
  const schemaString = await getSchemaAsString();

  const messages: MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content }) as MessageParam),
    { role: "user", content: userMessage },
  ];

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    tools: BRAIN_TOOLS,
    system: buildSystemPrompt(schemaString),
    messages,
  });

  while (response.stop_reason === "tool_use") {
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
    messages.push({ role: "user", content: toolResults as ContentBlockParam[] });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      tools: BRAIN_TOOLS,
      system: buildSystemPrompt(schemaString),
      messages,
    });
  }

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.type === "text"
    ? textBlock.text
    : "I processed your request but had nothing to say.";
}

const ENRICH_TOOLS = BRAIN_TOOLS.filter((t) =>
  ["get_schema", "create_node", "create_relationship", "propose_schema_addition"].includes(t.name),
);

const MAX_ENRICH_ROUNDS = 5;

export async function enrichContextForMessage(
  message: string,
): Promise<string> {
  const schemaString = await getSchemaAsString();

  const messages: MessageParam[] = [
    { role: "user", content: message },
  ];

  let response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    tools: ENRICH_TOOLS,
    system: `You are a background entity extractor. Given a user's message, extract any people, places, dates, events, or concepts and store them as nodes in the knowledge graph. Create relationships between entities when the message implies a connection.

Rules:
- Use get_schema first to see available types
- Use existing node/relationship types when they fit
- Only propose new types if nothing in the schema works
- Be efficient — batch what you can, skip trivial messages with no extractable entities
- Do NOT reply to the user — just extract and store, then say "done" or "nothing to extract"

Current schema:
${schemaString}`,
    messages,
  });

  let rounds = 0;
  while (response.stop_reason === "tool_use" && rounds < MAX_ENRICH_ROUNDS) {
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
    messages.push({ role: "user", content: toolResults as ContentBlockParam[] });

    response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      tools: ENRICH_TOOLS,
      system: `You are a background entity extractor. Store entities and relationships from the user's message into the knowledge graph. Say "done" when finished.

Current schema:
${schemaString}`,
      messages,
    });
  }

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "done";
}
