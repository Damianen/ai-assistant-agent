import cron from "node-cron";
import { bot } from "../lib/telegram.js";
import { redis } from "../lib/redis.js";
import { getRecentlyEndedEvents } from "../services/calendar.js";
import { setPostMeetingState } from "../services/accountability.js";
import { logger } from "../lib/logger.js";

const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.YOUR_CHAT_ID;

export const postMeetingCron = cron.schedule(
  "* * * * *",
  async () => {
    if (!chatId) return;

    try {
      const events = await getRecentlyEndedEvents(2);

      for (const event of events) {
        const redisKey = `post-meeting:${event.id}`;
        if (await redis.exists(redisKey)) continue;

        await bot.api.sendMessage(
          chatId,
          `Any action items from "${event.summary}"? I'll turn them into commitments.`,
        );
        setPostMeetingState(chatId, event.summary);
        await redis.set(redisKey, "1", "EX", 3600);
      }
    } catch (err) {
      logger.error({ err }, "Post-meeting check failed");
    }
  },
);
