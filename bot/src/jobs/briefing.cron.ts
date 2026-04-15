import cron from "node-cron";
import { bot } from "../lib/telegram.js";
import { redis } from "../lib/redis.js";
import { prisma } from "../db/prisma.js";
import { getDailyBrief } from "../services/briefing.js";
import { logger } from "../lib/logger.js";
import { getTimezone } from "../lib/settings.js";

const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.YOUR_CHAT_ID;
const DEFAULT_MORNING_HOUR = 8;

export const briefingCron = cron.schedule(
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
      if (now.getMinutes() !== 0) return;

      const settings = await prisma.userSettings.findUnique({
        where: { chatId },
      });
      const targetHour = settings?.morningBriefHour ?? DEFAULT_MORNING_HOUR;
      if (currentHour !== targetHour) return;

      const today = now.toISOString().slice(0, 10);
      const redisKey = `briefing-sent:${today}`;
      if (await redis.exists(redisKey)) return;

      const brief = await getDailyBrief(chatId);
      await bot.api.sendMessage(chatId, brief);
      await redis.set(redisKey, "1", "EX", 86400);
    } catch (err) {
      logger.error({ err }, "Daily briefing failed");
    }
  },
);
