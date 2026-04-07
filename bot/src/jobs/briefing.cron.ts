import cron from "node-cron";
import { bot } from "../lib/telegram.js";
import { getDailyBrief } from "../services/briefing.js";
import { logger } from "../lib/logger.js";

const chatId = process.env.TELEGRAM_CHAT_ID;

export const briefingCron = cron.schedule(
  "0 8 * * *",
  async () => {
    if (!chatId) {
      logger.warn("TELEGRAM_CHAT_ID not set, skipping daily briefing");
      return;
    }

    try {
      const brief = await getDailyBrief(chatId);
      await bot.api.sendMessage(chatId, brief);
    } catch (err) {
      logger.error({ err }, "Daily briefing failed");
    }
  },
  { timezone: "Europe/Amsterdam" },
);
