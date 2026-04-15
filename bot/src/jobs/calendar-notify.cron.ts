import cron from "node-cron";
import { bot } from "../lib/telegram.js";
import { redis } from "../lib/redis.js";
import { prisma } from "../db/prisma.js";
import { getUpcomingEventsRaw } from "../services/calendar.js";
import { logger } from "../lib/logger.js";

const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.YOUR_CHAT_ID;
const DEFAULT_REMINDER_MINUTES = 5;

async function getSettings() {
  if (!chatId) return { reminderMinutes: DEFAULT_REMINDER_MINUTES, timezone: "Europe/Amsterdam" };
  const settings = await prisma.userSettings.findUnique({
    where: { chatId },
  });
  return {
    reminderMinutes: settings?.calendarReminderMinutes ?? DEFAULT_REMINDER_MINUTES,
    timezone: settings?.timezone ?? "Europe/Amsterdam",
  };
}

export const calendarNotifyCron = cron.schedule(
  "* * * * *",
  async () => {
    if (!chatId) return;

    try {
      const { reminderMinutes } = await getSettings();
      if (reminderMinutes <= 0) return; // notifications disabled

      const events = await getUpcomingEventsRaw(reminderMinutes);

      for (const event of events) {
        const redisKey = `cal-notified:${event.id}`;
        const alreadySent = await redis.exists(redisKey);
        if (alreadySent) continue;

        const minutesUntil = Math.round(
          (event.start.getTime() - Date.now()) / 60_000,
        );
        const label =
          minutesUntil <= 1 ? "Starting now" : `Starting in ${minutesUntil} min`;

        await bot.api.sendMessage(chatId, `📅 ${label}: ${event.summary}`);
        await redis.set(redisKey, "1", "EX", reminderMinutes * 60 * 2);
      }
    } catch (err) {
      logger.error({ err }, "Calendar notification check failed");
    }
  },
);
