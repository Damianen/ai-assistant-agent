import { Worker } from "bullmq";
import { bot } from "../lib/telegram.js";
import { redis } from "../lib/redis.js";
import { prisma } from "../db/prisma.js";
import { setCheckInState } from "../services/accountability.js";
import { logger } from "../lib/logger.js";

export const accountabilityWorker = new Worker(
  "accountability",
  async (job) => {
    const { type, commitmentId, chatId } = job.data;

    if (type === "commitment_deadline") {
      const commitment = await prisma.commitment.findUnique({
        where: { id: commitmentId },
      });

      if (!commitment || commitment.status !== "pending") return;

      await bot.api.sendMessage(
        chatId,
        `You committed to "${commitment.text}" by now. Did you get it done?`,
      );

      setCheckInState(chatId, "commitment_followup", [commitmentId]);
    }
  },
  { connection: redis },
);

accountabilityWorker.on("failed", (job, err) => {
  logger.error({ err, jobId: job?.id }, "Accountability job failed");
});
