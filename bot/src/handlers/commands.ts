import type { Context } from "grammy";
import { prisma } from "../db/prisma.js";
import { runQuery } from "../db/graph.js";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

const startTime = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function checkPostgres(): Promise<string> {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return "connected";
  } catch {
    return "disconnected";
  }
}

async function checkFalkorDB(): Promise<string> {
  try {
    await runQuery("RETURN 1");
    return "connected";
  } catch {
    return "disconnected";
  }
}

async function checkRedis(): Promise<string> {
  try {
    await redis.ping();
    return "connected";
  } catch {
    return "disconnected";
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  try {
    const [pg, falkor, red, pendingReminders, nodeCountResult] =
      await Promise.all([
        checkPostgres(),
        checkFalkorDB(),
        checkRedis(),
        prisma.reminder.count({
          where: { fired: false, cancelled: false },
        }),
        runQuery("MATCH (n) RETURN count(n) AS c").catch(() => []),
      ]);

    const nodeCount =
      nodeCountResult.length > 0 ? (nodeCountResult[0]?.c ?? 0) : 0;
    const uptime = formatUptime(Date.now() - startTime);

    const lines = [
      `Uptime: ${uptime}`,
      `Postgres: ${pg}`,
      `FalkorDB: ${falkor}`,
      `Redis: ${red}`,
      `Pending reminders: ${pendingReminders}`,
      `Graph nodes: ${nodeCount}`,
    ];

    await ctx.reply(lines.join("\n"));
  } catch (err) {
    logger.error({ err }, "/status failed");
    await ctx.reply("Failed to gather status info.");
  }
}

export async function handleHelp(ctx: Context): Promise<void> {
  const text = [
    "Here's what I can do:\n",
    "Reminders",
    '  "Remind me to call Mom tomorrow at 3pm"',
    '  "Remind me to take meds every day at 9am"\n',
    "Lists",
    '  "Add milk to my shopping list"',
    '  "Show my todo list"',
    '  "Remove milk from shopping list"\n',
    "Memory",
    '  "Remember that Sarah\'s birthday is March 12"',
    '  "What do you know about Sarah?"\n',
    "Briefing",
    '  "Give me my daily briefing"\n',
    "Voice",
    "  Send a voice message and I'll transcribe and process it\n",
    "Commands",
    "  /status — system health check",
    "  /help — this message",
  ];

  await ctx.reply(text.join("\n"));
}
