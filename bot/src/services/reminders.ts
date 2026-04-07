import { Queue } from "bullmq";
import { prisma } from "../db/prisma.js";
import { redis } from "../lib/redis.js";

const reminderQueue = new Queue("reminders", { connection: redis });

export async function createReminder(
  chatId: string,
  text: string,
  fireAt: Date,
  recurrence?: string | null,
) {
  const delayMs = Math.max(0, fireAt.getTime() - Date.now());

  let job;
  if (recurrence) {
    job = await reminderQueue.add("remind", { chatId, text }, { repeat: { pattern: recurrence } });
  } else {
    job = await reminderQueue.add("remind", { chatId, text }, { delay: delayMs });
  }

  const reminder = await prisma.reminder.create({
    data: {
      chatId,
      text,
      fireAt,
      recurrence: recurrence ?? null,
      bullJobId: job.id ?? null,
    },
  });

  return reminder;
}

export async function cancelReminder(reminderId: string) {
  const reminder = await prisma.reminder.findUniqueOrThrow({ where: { id: reminderId } });

  if (reminder.recurrence) {
    // For repeatable jobs, we must remove by name + repeat options
    await reminderQueue.removeRepeatable("remind", { pattern: reminder.recurrence });
  } else if (reminder.bullJobId) {
    const job = await reminderQueue.getJob(reminder.bullJobId);
    if (job) await job.remove();
  }

  return prisma.reminder.update({
    where: { id: reminderId },
    data: { cancelled: true },
  });
}
