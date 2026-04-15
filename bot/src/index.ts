import "dotenv/config";
import { createServer } from "node:http";
import { logger } from "./lib/logger.js";
import { bot } from "./lib/telegram.js";
import { prisma } from "./db/prisma.js";
import { reminderWorker } from "./jobs/reminder.worker.js";
import { briefingCron } from "./jobs/briefing.cron.js";
import { reflectionCron } from "./jobs/reflection.cron.js";
import { calendarNotifyCron } from "./jobs/calendar-notify.cron.js";
import { accountabilityWorker } from "./jobs/accountability.worker.js";
import { eveningCheckInCron } from "./jobs/evening-checkin.cron.js";
import { weeklyReportCron } from "./jobs/weekly-report.cron.js";
import { habitNudgeCron } from "./jobs/habit-nudge.cron.js";
import { postMeetingCron } from "./jobs/post-meeting.cron.js";
import { handleMessage } from "./handlers/message.js";
import { handleVoice } from "./handlers/voice.js";
import { handlePhoto } from "./handlers/photo.js";
import { handleStatus, handleHelp, handleReset, handleClear } from "./handlers/commands.js";
import { seedSchema } from "./db/schema-registry.js";
import { runQuery, closeGraph } from "./db/graph.js";
import { isRateLimited } from "./lib/rate-limiter.js";
import { handleOAuthCallback } from "./services/calendar.js";

// ---------------------------------------------------------------------------
// Global error handlers — log and let the process recover
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled rejection");
});

// ---------------------------------------------------------------------------
// Health check server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date() }));
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/oauth/callback")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error || !code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(error ?? "Missing authorization code");
      return;
    }

    try {
      await handleOAuthCallback(code);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Google Calendar connected! You can close this tab.");

      const chatId = process.env.YOUR_CHAT_ID;
      if (chatId) {
        bot.api.sendMessage(chatId, "Google Calendar connected ✓").catch(() => {});
      }
    } catch (err) {
      logger.error({ err }, "OAuth callback failed");
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to connect Google Calendar");
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(3001, () => {
  logger.info("Health check listening on :3001");
});

// ---------------------------------------------------------------------------
// Rate limiter middleware — applied before all message handlers
// ---------------------------------------------------------------------------
bot.on("message", async (ctx, next) => {
  const chatId = ctx.chat?.id?.toString();
  if (chatId && isRateLimited(chatId)) {
    await ctx.reply("Slow down — I'm processing your previous messages");
    return;
  }
  await next();
});

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
bot.command("status", handleStatus);
bot.command("help", handleHelp);
bot.command("reset", handleReset);
bot.command("clear", handleClear);

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------
bot.on("message:text", handleMessage);
bot.on("message:voice", handleVoice);
bot.on("message:photo", handlePhoto);

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
bot.catch((err) => {
  logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "Bot error");
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal: string) {
  return async () => {
    logger.info({ signal }, "Shutting down");
    bot.stop();
    briefingCron.stop();
    reflectionCron.stop();
    calendarNotifyCron.stop();
    eveningCheckInCron.stop();
    weeklyReportCron.stop();
    habitNudgeCron.stop();
    postMeetingCron.stop();
    await reminderWorker.close();
    await accountabilityWorker.close();
    await prisma.$disconnect();
    await closeGraph();
    server.close();
    process.exit(0);
  };
}

process.on("SIGTERM", shutdown("SIGTERM"));
process.on("SIGINT", shutdown("SIGINT"));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
try {
  await runQuery("RETURN 1");
  logger.info("FalkorDB connected");
} catch (err) {
  logger.error({ err }, "FalkorDB connection failed");
}

await seedSchema();
bot.start();
logger.info("Bot is running");
