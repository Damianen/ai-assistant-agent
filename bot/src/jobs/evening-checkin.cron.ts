import cron from "node-cron";
import { bot } from "../lib/telegram.js";
import { redis } from "../lib/redis.js";
import { prisma } from "../db/prisma.js";
import {
  getTodaysDueCommitments,
  getTodaysHabitStatus,
  setCheckInState,
} from "../services/accountability.js";
import { logger } from "../lib/logger.js";

const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.YOUR_CHAT_ID;
const TIMEZONE = "Europe/Amsterdam";
const DEFAULT_EVENING_HOUR = 21;

export const eveningCheckInCron = cron.schedule(
  "* * * * *",
  async () => {
    if (!chatId) return;

    try {
      const now = new Date();
      const currentHour = parseInt(
        now.toLocaleString("en-US", {
          timeZone: TIMEZONE,
          hour: "numeric",
          hour12: false,
        }),
      );
      if (now.getMinutes() !== 0) return;

      const settings = await prisma.userSettings.findUnique({
        where: { chatId },
      });
      const targetHour = settings?.eveningCheckInHour ?? DEFAULT_EVENING_HOUR;
      if (currentHour !== targetHour) return;

      const today = now.toISOString().slice(0, 10);
      const redisKey = `checkin-sent:${today}`;
      if (await redis.exists(redisKey)) return;

      const [commitments, habitStatus] = await Promise.all([
        getTodaysDueCommitments(chatId),
        getTodaysHabitStatus(chatId),
      ]);

      if (commitments.length === 0 && habitStatus.length === 0) return;

      const lines: string[] = ["Time to check in. How'd today go?\n"];

      if (commitments.length > 0) {
        lines.push("Commitments due:");
        for (const c of commitments) {
          lines.push(`  - ${c.text}`);
        }
        lines.push("");
      }

      const activeHabits = habitStatus.filter(
        (h) => !h.skippedToday && !h.completedToday,
      );
      const skippedHabits = habitStatus.filter((h) => h.skippedToday);

      if (activeHabits.length > 0) {
        lines.push("Habits:");
        for (const h of activeHabits) {
          const progress = `${h.completionsThisWeek}/${h.target} this week`;
          lines.push(`  - ${h.habit.text} (${progress})`);
        }
      }

      if (skippedHabits.length > 0) {
        for (const h of skippedHabits) {
          lines.push(`  - ${h.habit.text} (skipped today)`);
        }
      }

      lines.push("\nJust tell me what you got done.");

      await bot.api.sendMessage(chatId, lines.join("\n"));

      // Only include non-skipped, non-completed habits in check-in state
      const itemIds = [
        ...commitments.map((c) => c.id),
        ...activeHabits.map((h) => h.habit.id),
      ];
      setCheckInState(chatId, "evening_checkin", itemIds);

      await redis.set(redisKey, "1", "EX", 86400);
    } catch (err) {
      logger.error({ err }, "Evening check-in failed");
    }
  },
  { timezone: TIMEZONE },
);
