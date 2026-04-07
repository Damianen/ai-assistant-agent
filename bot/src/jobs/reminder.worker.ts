import { Worker } from "bullmq";
import { bot } from "../lib/telegram.js";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

export const reminderWorker = new Worker(
  "reminders",
  async (job) => {
    const chatId = job.data.chatId;
    if (!chatId) throw new Error("Job missing chatId");

    await bot.api.sendMessage(chatId, "\u{1F514} " + job.data.text);
  },
  { connection: redis },
);

reminderWorker.on("failed", (job, err) => {
  logger.error({ err, jobId: job?.id }, "Reminder job failed");
});
