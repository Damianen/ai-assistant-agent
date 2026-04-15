import cron from "node-cron";
import { bot } from "../lib/telegram.js";
import { redis } from "../lib/redis.js";
import { getTodaysHabitStatus } from "../services/accountability.js";
import { logger } from "../lib/logger.js";
import { getTimezone } from "../lib/settings.js";

const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.YOUR_CHAT_ID;
const NUDGE_HOUR = 15; // 3pm

export const habitNudgeCron = cron.schedule(
  "* * * * *",
  async () => {
    if (!chatId) return;

    try {
      const tz = await getTimezone(chatId);
      const now = new Date();
      const currentHour = parseInt(
        now.toLocaleString("en-US", {
          timeZone: tz,
          hour: "numeric",
          hour12: false,
        }),
      );
      if (now.getMinutes() !== 0 || currentHour !== NUDGE_HOUR) return;

      const today = now.toISOString().slice(0, 10);
      const redisKey = `habit-nudge:${today}`;
      if (await redis.exists(redisKey)) return;

      const habitStatus = await getTodaysHabitStatus(chatId);
      if (habitStatus.length === 0) return;

      // Find habits that are falling behind
      const dayOfWeek = new Date(
        now.toLocaleString("en-US", { timeZone: tz }),
      ).getDay();
      // Days remaining in the rolling week (including today)
      const daysRemaining = Math.max(1, 7 - dayOfWeek);

      const behind = habitStatus.filter((h) => {
        if (h.completedToday || h.skippedToday) return false;
        const sessionsRemaining = h.target - h.completionsThisWeek;
        return sessionsRemaining > 0 && sessionsRemaining >= daysRemaining;
      });

      if (behind.length === 0) {
        await redis.set(redisKey, "1", "EX", 86400);
        return;
      }

      const lines = behind.map((h) => {
        const remaining = h.target - h.completionsThisWeek;
        return `- ${h.habit.text}: need ${remaining} more this week (${h.completionsThisWeek}/${h.target})`;
      });

      await bot.api.sendMessage(
        chatId,
        `Heads up — you're falling behind on:\n${lines.join("\n")}`,
      );
      await redis.set(redisKey, "1", "EX", 86400);
    } catch (err) {
      logger.error({ err }, "Habit nudge failed");
    }
  },
);
