import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import { bot } from "../lib/telegram.js";
import { prisma } from "../db/prisma.js";
import {
  getWeeklyStats,
  type WeeklyAccountabilityStats,
} from "../services/accountability.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic();
const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.YOUR_CHAT_ID;
const TIMEZONE = "Europe/Amsterdam";

function buildReportPrompt(stats: WeeklyAccountabilityStats): string {
  const missedList =
    stats.commitments.missedItems.length > 0
      ? stats.commitments.missedItems
          .map(
            (c) =>
              `  - MISSED: "${c.text}" (due ${c.deadline.toLocaleDateString("en-US", { timeZone: TIMEZONE, weekday: "short", month: "short", day: "numeric" })})`,
          )
          .join("\n")
      : "  None";

  const habitLines =
    stats.habits.length > 0
      ? stats.habits
          .map(
            (h) =>
              `- ${h.text}: ${h.actual}/${h.target} this week (streak: ${h.streak} week${h.streak !== 1 ? "s" : ""})`,
          )
          .join("\n")
      : "No active habits.";

  return `You are an accountability partner writing a weekly report. Be direct, stats-driven, and constructive. No sugarcoating. If something was missed repeatedly, call it out and ask what's blocking progress. If things went well, acknowledge briefly and push for consistency.

Format as a clean Telegram message. Use emoji sparingly. Max 400 words.

This week's data:

COMMITMENTS:
- Total: ${stats.commitments.total}
- Completed: ${stats.commitments.completed}
- Missed: ${stats.commitments.missed}
${missedList}

HABITS:
${habitLines}

Overall completion rate: ${stats.overallScore}%

Write the weekly accountability report.`;
}

export const weeklyReportCron = cron.schedule(
  "0 20 * * 0", // Sunday 8pm
  async () => {
    if (!chatId) return;

    try {
      // Mark overdue pending commitments as missed
      await prisma.commitment.updateMany({
        where: {
          chatId,
          status: "pending",
          deadline: { lt: new Date() },
        },
        data: { status: "missed" },
      });

      const stats = await getWeeklyStats(chatId);

      // Skip if there's nothing to report
      if (stats.commitments.total === 0 && stats.habits.length === 0) return;

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: buildReportPrompt(stats) }],
      });

      const block = response.content[0];
      if (block.type === "text") {
        await bot.api.sendMessage(chatId, block.text);
      }
    } catch (err) {
      logger.error({ err }, "Weekly accountability report failed");
    }
  },
  { timezone: TIMEZONE },
);
