import { Queue } from "bullmq";
import { prisma } from "../db/prisma.js";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

const TIMEZONE = "Europe/Amsterdam";
const accountabilityQueue = new Queue("accountability", { connection: redis });

// ---------------------------------------------------------------------------
// Check-in state (in-memory, single-user bot)
// ---------------------------------------------------------------------------

interface CheckInState {
  mode: "evening_checkin" | "commitment_followup";
  pendingItemIds: string[];
  expiresAt: number;
}

const activeCheckIns = new Map<string, CheckInState>();

export function setCheckInState(
  chatId: string,
  mode: CheckInState["mode"],
  itemIds: string[],
  ttlMs = 30 * 60 * 1000,
): void {
  activeCheckIns.set(chatId, {
    mode,
    pendingItemIds: itemIds,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getCheckInState(chatId: string): CheckInState | null {
  const state = activeCheckIns.get(chatId);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    activeCheckIns.delete(chatId);
    return null;
  }
  return state;
}

export function clearCheckInState(chatId: string): void {
  activeCheckIns.delete(chatId);
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function startOfTodayInTz(): Date {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: TIMEZONE }); // YYYY-MM-DD
  return new Date(`${dateStr}T00:00:00`);
}

function endOfTodayInTz(): Date {
  const start = startOfTodayInTz();
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function startOfDayInTz(date: Date): Date {
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  return new Date(`${dateStr}T00:00:00`);
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

export async function createCommitment(
  chatId: string,
  text: string,
  deadline: Date,
) {
  const delayMs = Math.max(0, deadline.getTime() - Date.now());

  const commitment = await prisma.commitment.create({
    data: { chatId, text, deadline },
  });

  const job = await accountabilityQueue.add(
    "commitment_deadline",
    { type: "commitment_deadline", commitmentId: commitment.id, chatId },
    { delay: delayMs },
  );

  await prisma.commitment.update({
    where: { id: commitment.id },
    data: { bullJobId: job.id ?? null },
  });

  return commitment;
}

export async function completeCommitment(chatId: string, searchText: string) {
  const commitment = await prisma.commitment.findFirst({
    where: {
      chatId,
      status: "pending",
      text: { contains: searchText, mode: "insensitive" },
    },
  });

  if (!commitment) return null;

  if (commitment.bullJobId) {
    const job = await accountabilityQueue.getJob(commitment.bullJobId);
    if (job) await job.remove().catch(() => {});
  }

  return prisma.commitment.update({
    where: { id: commitment.id },
    data: { status: "completed" },
  });
}

export async function rescheduleCommitment(
  commitmentId: string,
  newDeadline: Date,
) {
  const commitment = await prisma.commitment.findUniqueOrThrow({
    where: { id: commitmentId },
  });

  // Remove old job
  if (commitment.bullJobId) {
    const job = await accountabilityQueue.getJob(commitment.bullJobId);
    if (job) await job.remove().catch(() => {});
  }

  const delayMs = Math.max(0, newDeadline.getTime() - Date.now());
  const newJob = await accountabilityQueue.add(
    "commitment_deadline",
    {
      type: "commitment_deadline",
      commitmentId,
      chatId: commitment.chatId,
    },
    { delay: delayMs },
  );

  return prisma.commitment.update({
    where: { id: commitmentId },
    data: {
      deadline: newDeadline,
      status: "pending",
      bullJobId: newJob.id ?? null,
    },
  });
}

export async function getPendingCommitments(chatId: string) {
  return prisma.commitment.findMany({
    where: { chatId, status: "pending" },
    orderBy: { deadline: "asc" },
  });
}

export async function getTodaysDueCommitments(chatId: string) {
  return prisma.commitment.findMany({
    where: {
      chatId,
      status: "pending",
      deadline: { lte: endOfTodayInTz() },
    },
    orderBy: { deadline: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

export async function createHabit(
  chatId: string,
  text: string,
  frequencyPerWeek: number,
) {
  return prisma.habit.create({
    data: { chatId, text, frequencyPerWeek },
  });
}

export async function logHabitCompletion(
  habitId: string,
  date: Date,
  completed: boolean,
) {
  const dayStart = startOfDayInTz(date);
  return prisma.habitLog.upsert({
    where: { habitId_date: { habitId, date: dayStart } },
    create: { habitId, date: dayStart, completed },
    update: { completed },
  });
}

export async function getActiveHabits(chatId: string) {
  return prisma.habit.findMany({
    where: { chatId, active: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function getTodaysHabitStatus(chatId: string) {
  const habits = await getActiveHabits(chatId);
  if (habits.length === 0) return [];

  const today = startOfTodayInTz();
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const results = await Promise.all(
    habits.map(async (habit) => {
      const logs = await prisma.habitLog.findMany({
        where: {
          habitId: habit.id,
          date: { gte: weekAgo, lte: today },
          completed: true,
        },
      });

      const completedToday = logs.some(
        (l) => l.date.getTime() === today.getTime(),
      );

      return {
        habit,
        completedToday,
        completionsThisWeek: logs.length,
        target: habit.frequencyPerWeek,
      };
    }),
  );

  return results;
}

export async function getHabitStreak(habitId: string): Promise<number> {
  const habit = await prisma.habit.findUniqueOrThrow({
    where: { id: habitId },
  });

  const logs = await prisma.habitLog.findMany({
    where: { habitId, completed: true },
    orderBy: { date: "desc" },
    take: 365, // cap at ~1 year
  });

  if (logs.length === 0) return 0;

  const today = startOfTodayInTz();
  let streak = 0;

  // Check consecutive 7-day windows going backwards
  for (let week = 0; week < 52; week++) {
    const windowEnd = new Date(
      today.getTime() - week * 7 * 24 * 60 * 60 * 1000,
    );
    const windowStart = new Date(
      windowEnd.getTime() - 6 * 24 * 60 * 60 * 1000,
    );

    const count = logs.filter(
      (l) => l.date >= windowStart && l.date <= windowEnd,
    ).length;

    if (count >= habit.frequencyPerWeek) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

// ---------------------------------------------------------------------------
// Check-in items (fetch details for stored IDs)
// ---------------------------------------------------------------------------

export interface CheckInItem {
  id: string;
  text: string;
  type: "commitment" | "habit";
}

export async function getCheckInItems(
  chatId: string,
  state: CheckInState,
): Promise<CheckInItem[]> {
  const [commitments, habits] = await Promise.all([
    prisma.commitment.findMany({
      where: { id: { in: state.pendingItemIds }, chatId, status: "pending" },
    }),
    prisma.habit.findMany({
      where: { id: { in: state.pendingItemIds }, chatId, active: true },
    }),
  ]);

  return [
    ...commitments.map((c) => ({
      id: c.id,
      text: c.text,
      type: "commitment" as const,
    })),
    ...habits.map((h) => ({
      id: h.id,
      text: h.text,
      type: "habit" as const,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Process check-in response
// ---------------------------------------------------------------------------

export async function processCheckInResponse(
  chatId: string,
  items: Array<{ text: string; completed: boolean }>,
): Promise<{ summary: string }> {
  const state = getCheckInState(chatId);
  if (!state) {
    return { summary: "No active check-in to respond to." };
  }

  const checkInItems = await getCheckInItems(chatId, state);
  const today = startOfTodayInTz();
  const completed: string[] = [];
  const missed: string[] = [];

  for (const parsed of items) {
    // Match parsed item to a check-in item by fuzzy text match
    const match = checkInItems.find((ci) =>
      ci.text.toLowerCase().includes(parsed.text.toLowerCase()) ||
      parsed.text.toLowerCase().includes(ci.text.toLowerCase()),
    );

    if (!match) continue;

    if (match.type === "commitment") {
      if (parsed.completed) {
        await prisma.commitment.update({
          where: { id: match.id },
          data: { status: "completed" },
        });
        completed.push(match.text);
      } else {
        await prisma.commitment.update({
          where: { id: match.id },
          data: { status: "missed" },
        });
        missed.push(match.text);
      }
    } else {
      await logHabitCompletion(match.id, today, parsed.completed);
      if (parsed.completed) {
        completed.push(match.text);
      } else {
        missed.push(match.text);
      }
    }
  }

  const parts: string[] = [];
  if (completed.length > 0) {
    parts.push(`Done: ${completed.join(", ")}.`);
  }
  if (missed.length > 0) {
    parts.push(
      `Missed: ${missed.join(", ")}. What got in the way?`,
    );
  }
  if (parts.length === 0) {
    parts.push("Couldn't match your response to the check-in items.");
  }

  return { summary: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Weekly stats
// ---------------------------------------------------------------------------

export interface WeeklyAccountabilityStats {
  commitments: {
    total: number;
    completed: number;
    missed: number;
    missedItems: Array<{ text: string; deadline: Date }>;
  };
  habits: Array<{
    text: string;
    target: number;
    actual: number;
    streak: number;
  }>;
  overallScore: number;
}

export async function getWeeklyStats(
  chatId: string,
): Promise<WeeklyAccountabilityStats> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Commitments that had deadlines this week
  const commitments = await prisma.commitment.findMany({
    where: {
      chatId,
      deadline: { gte: weekAgo, lte: now },
    },
  });

  const completedCommitments = commitments.filter(
    (c) => c.status === "completed",
  );
  const missedCommitments = commitments.filter((c) => c.status === "missed");

  // Habit stats
  const habits = await getActiveHabits(chatId);
  const today = startOfTodayInTz();
  const rollingWeekStart = new Date(
    today.getTime() - 6 * 24 * 60 * 60 * 1000,
  );

  const habitStats = await Promise.all(
    habits.map(async (habit) => {
      const logs = await prisma.habitLog.findMany({
        where: {
          habitId: habit.id,
          date: { gte: rollingWeekStart, lte: today },
          completed: true,
        },
      });

      const streak = await getHabitStreak(habit.id);

      return {
        text: habit.text,
        target: habit.frequencyPerWeek,
        actual: logs.length,
        streak,
      };
    }),
  );

  // Overall score
  const totalItems =
    commitments.length +
    habitStats.reduce((sum, h) => sum + h.target, 0);
  const completedItems =
    completedCommitments.length +
    habitStats.reduce((sum, h) => sum + Math.min(h.actual, h.target), 0);
  const overallScore =
    totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 100;

  return {
    commitments: {
      total: commitments.length,
      completed: completedCommitments.length,
      missed: missedCommitments.length,
      missedItems: missedCommitments.map((c) => ({
        text: c.text,
        deadline: c.deadline,
      })),
    },
    habits: habitStats,
    overallScore,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function updateAccountabilitySettings(
  chatId: string,
  morningHour?: number,
  eveningHour?: number,
) {
  const data: Record<string, number> = {};
  if (morningHour !== undefined) data.morningBriefHour = morningHour;
  if (eveningHour !== undefined) data.eveningCheckInHour = eveningHour;

  return prisma.userSettings.upsert({
    where: { chatId },
    create: { chatId, ...data },
    update: data,
  });
}
