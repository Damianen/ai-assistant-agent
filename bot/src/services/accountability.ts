import { Queue } from "bullmq";
import { prisma } from "../db/prisma.js";
import { redis } from "../lib/redis.js";
import { bot } from "../lib/telegram.js";
import { logger } from "../lib/logger.js";

import { getTimezone } from "../lib/settings.js";

const accountabilityQueue = new Queue("accountability", { connection: redis });

// ---------------------------------------------------------------------------
// Check-in state (in-memory, single-user bot)
// ---------------------------------------------------------------------------

interface CheckInState {
  mode: "evening_checkin" | "commitment_followup" | "post_meeting";
  pendingItemIds: string[];
  eventSummary?: string;
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

export function setPostMeetingState(
  chatId: string,
  eventSummary: string,
  ttlMs = 30 * 60 * 1000,
): void {
  activeCheckIns.set(chatId, {
    mode: "post_meeting",
    pendingItemIds: [],
    eventSummary,
    expiresAt: Date.now() + ttlMs,
  });
}

export function clearCheckInState(chatId: string): void {
  activeCheckIns.delete(chatId);
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function startOfTodayInTz(tz: string): Date {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  return new Date(`${dateStr}T00:00:00`);
}

function endOfTodayInTz(tz: string): Date {
  const start = startOfTodayInTz(tz);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

function startOfDayInTz(date: Date, tz: string): Date {
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: tz });
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
  const tz = await getTimezone(chatId);
  return prisma.commitment.findMany({
    where: {
      chatId,
      status: "pending",
      deadline: { lte: endOfTodayInTz(tz) },
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
  chatId?: string,
) {
  const tz = await getTimezone(chatId);
  const dayStart = startOfDayInTz(date, tz);
  return prisma.habitLog.upsert({
    where: { habitId_date: { habitId, date: dayStart } },
    create: { habitId, date: dayStart, completed },
    update: { completed },
  });
}

export async function skipHabitToday(
  chatId: string,
  searchText: string,
  reason?: string,
) {
  const habit = await prisma.habit.findFirst({
    where: {
      chatId,
      active: true,
      text: { contains: searchText, mode: "insensitive" },
    },
  });

  if (!habit) return null;

  const tz = await getTimezone(chatId);
  const today = startOfTodayInTz(tz);
  await prisma.habitLog.upsert({
    where: { habitId_date: { habitId: habit.id, date: today } },
    create: {
      habitId: habit.id,
      date: today,
      completed: false,
      skipped: true,
      skipReason: reason ?? null,
    },
    update: { completed: false, skipped: true, skipReason: reason ?? null },
  });

  return habit;
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

  const tz = await getTimezone(chatId);
  const today = startOfTodayInTz(tz);
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const results = await Promise.all(
    habits.map(async (habit) => {
      const logs = await prisma.habitLog.findMany({
        where: {
          habitId: habit.id,
          date: { gte: weekAgo, lte: today },
        },
      });

      const todayLog = logs.find(
        (l) => l.date.getTime() === today.getTime(),
      );
      const completedToday = todayLog?.completed === true;
      const skippedToday = todayLog?.skipped === true;
      const completionsThisWeek = logs.filter((l) => l.completed).length;

      return {
        habit,
        completedToday,
        skippedToday,
        completionsThisWeek,
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
    where: { habitId },
    orderBy: { date: "desc" },
    take: 365,
  });

  if (logs.length === 0) return 0;

  const tz = await getTimezone(habit.chatId);
  const today = startOfTodayInTz(tz);
  let streak = 0;

  // Check consecutive 7-day windows going backwards
  // Skipped days count toward the target (don't break streaks)
  for (let week = 0; week < 52; week++) {
    const windowEnd = new Date(
      today.getTime() - week * 7 * 24 * 60 * 60 * 1000,
    );
    const windowStart = new Date(
      windowEnd.getTime() - 6 * 24 * 60 * 60 * 1000,
    );

    const windowLogs = logs.filter(
      (l) => l.date >= windowStart && l.date <= windowEnd,
    );
    const completed = windowLogs.filter((l) => l.completed).length;
    const skipped = windowLogs.filter((l) => l.skipped).length;

    if (completed + skipped >= habit.frequencyPerWeek) {
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
  const tz = await getTimezone(chatId);
  const today = startOfTodayInTz(tz);
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

  // Check for streak milestones after logging completions
  checkStreakMilestones(chatId).catch((err) =>
    logger.error({ err }, "Streak milestone check failed"),
  );

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
  const tz = await getTimezone(chatId);
  const today = startOfTodayInTz(tz);
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
// Cancel commitment / deactivate habit
// ---------------------------------------------------------------------------

export async function cancelCommitment(chatId: string, searchText: string) {
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
    data: { status: "cancelled" },
  });
}

export async function deactivateHabit(chatId: string, searchText: string) {
  const habit = await prisma.habit.findFirst({
    where: {
      chatId,
      active: true,
      text: { contains: searchText, mode: "insensitive" },
    },
  });

  if (!habit) return null;

  return prisma.habit.update({
    where: { id: habit.id },
    data: { active: false },
  });
}

// ---------------------------------------------------------------------------
// Query / overview formatting
// ---------------------------------------------------------------------------

export async function formatCommitmentsOverview(
  chatId: string,
): Promise<string> {
  const commitments = await getPendingCommitments(chatId);

  if (commitments.length === 0) return "No pending commitments.";

  const tz = await getTimezone(chatId);
  const lines = commitments.map((c) => {
    const deadline = c.deadline.toLocaleDateString("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const daysLeft = Math.ceil(
      (c.deadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );
    const urgency =
      daysLeft <= 0 ? " (OVERDUE)" : daysLeft <= 1 ? " (due today)" : "";
    return `- ${c.text} — by ${deadline}${urgency}`;
  });

  return `Pending commitments:\n${lines.join("\n")}`;
}

export async function formatHabitsOverview(chatId: string): Promise<string> {
  const habitStatus = await getTodaysHabitStatus(chatId);

  if (habitStatus.length === 0) return "No active habits.";

  const lines = await Promise.all(
    habitStatus.map(async (h) => {
      const streak = await getHabitStreak(h.habit.id);
      const todayMark = h.completedToday ? " ✓ today" : "";
      const streakLabel = streak > 0 ? ` (${streak}w streak)` : "";
      return `- ${h.habit.text}: ${h.completionsThisWeek}/${h.target} this week${todayMark}${streakLabel}`;
    }),
  );

  return `Active habits:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// On-demand stats
// ---------------------------------------------------------------------------

export async function formatAccountabilityStats(
  chatId: string,
): Promise<string> {
  const stats = await getWeeklyStats(chatId);

  const lines: string[] = ["This week's accountability:\n"];

  // Commitments
  if (stats.commitments.total > 0) {
    lines.push(
      `Commitments: ${stats.commitments.completed}/${stats.commitments.total} completed`,
    );
    if (stats.commitments.missed > 0) {
      lines.push(
        `  Missed: ${stats.commitments.missedItems.map((c) => c.text).join(", ")}`,
      );
    }
  } else {
    lines.push("No commitments this week.");
  }

  // Habits
  if (stats.habits.length > 0) {
    lines.push("");
    lines.push("Habits:");
    for (const h of stats.habits) {
      const streakLabel = h.streak > 0 ? ` (${h.streak}w streak)` : "";
      lines.push(`  - ${h.text}: ${h.actual}/${h.target}${streakLabel}`);
    }
  }

  lines.push(`\nOverall score: ${stats.overallScore}%`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Streak milestones
// ---------------------------------------------------------------------------

const MILESTONE_WEEKS = [1, 4, 8, 12, 26, 52];

export async function checkStreakMilestones(chatId: string): Promise<void> {
  const habits = await getActiveHabits(chatId);

  for (const habit of habits) {
    const streak = await getHabitStreak(habit.id);
    if (!MILESTONE_WEEKS.includes(streak)) continue;

    const redisKey = `streak-milestone:${habit.id}:${streak}`;
    if (await redis.exists(redisKey)) continue;

    const label =
      streak === 1
        ? "1 week"
        : streak < 52
          ? `${streak} weeks`
          : "1 year";

    await bot.api.sendMessage(
      chatId,
      `🔥 ${label} streak on "${habit.text}"! Keep it going.`,
    );
    await redis.set(redisKey, "1", "EX", 30 * 24 * 60 * 60); // 30 day TTL
  }
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
