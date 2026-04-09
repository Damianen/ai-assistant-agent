import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db/prisma.js";
import { createCommitment } from "./accountability.js";
import { createCalendarEvent } from "./calendar.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic();
const TIMEZONE = "Europe/Amsterdam";

// ---------------------------------------------------------------------------
// Goal plan types
// ---------------------------------------------------------------------------

interface GoalPlanMilestone {
  text: string;
  targetDate: string;
}

interface GoalPlanHabit {
  text: string;
  frequencyPerWeek: number;
}

interface GoalPlanCommitment {
  text: string;
  deadline: string;
}

interface GoalPlanCalendarEvent {
  summary: string;
  start: string;
  end: string;
  recurrence?: string;
  description?: string;
}

interface GoalPlan {
  milestones: GoalPlanMilestone[];
  habits: GoalPlanHabit[];
  commitments: GoalPlanCommitment[];
  calendarEvents: GoalPlanCalendarEvent[];
}

// ---------------------------------------------------------------------------
// Goal planning state (in-memory, single-user bot)
// ---------------------------------------------------------------------------

interface GoalPlanningState {
  goalId: string;
  goalTitle: string;
  planSummary: string;
  expiresAt: number;
}

const activeGoalPlanning = new Map<string, GoalPlanningState>();

export function setGoalPlanningState(
  chatId: string,
  goalId: string,
  goalTitle: string,
  planSummary: string,
  ttlMs = 30 * 60 * 1000,
): void {
  activeGoalPlanning.set(chatId, {
    goalId,
    goalTitle,
    planSummary,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getGoalPlanningState(chatId: string): GoalPlanningState | null {
  const state = activeGoalPlanning.get(chatId);
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    activeGoalPlanning.delete(chatId);
    return null;
  }
  return state;
}

export function clearGoalPlanningState(chatId: string): void {
  activeGoalPlanning.delete(chatId);
}

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

function buildPlanPrompt(title: string, description?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `You are a goal planning assistant. Create an actionable plan to help the user achieve their goal.

Today: ${dateStr}
Timezone: ${TIMEZONE}

Goal: ${title}${description ? `\n\nUser's full message (may contain detailed plans, context, or documents):\n${description}` : ""}

Create a structured plan with:
- **Milestones**: 3-8 key milestones covering the full journey. Each needs a realistic target date (ISO8601).
- **Habits**: Recurring behaviors that support this goal (0-4 habits). Each needs frequency per week (1-7).
- **Commitments**: Near-term one-time tasks for the first 2 weeks (0-5 commitments). Each needs a deadline (ISO8601).
- **Calendar events**: Only if specific scheduled time blocks are needed (0-3 events). Include recurrence (RRULE) for recurring blocks.

Guidelines:
- Be practical and realistic — don't overload the user
- Milestones should span the full goal timeline
- Commitments should focus on immediate next actions only
- Habits should be concrete and measurable
- Calendar events are optional — only for goals that need dedicated time blocks
- For simple goals (quit a habit, build a routine), keep the plan light
- For complex goals (build a business, learn a skill), be more thorough

Return ONLY valid JSON with no explanation, no markdown, no backticks. Use this exact shape:
{
  "milestones": [{ "text": "string", "targetDate": "ISO8601" }],
  "habits": [{ "text": "string", "frequencyPerWeek": number }],
  "commitments": [{ "text": "string", "deadline": "ISO8601" }],
  "calendarEvents": [{ "summary": "string", "start": "ISO8601", "end": "ISO8601", "recurrence": "RRULE string or null", "description": "string or null" }]
}`;
}

async function generateGoalPlan(
  title: string,
  description?: string,
): Promise<GoalPlan> {
  // Use more tokens when the user provided detailed context
  const maxTokens = description && description.length > 500 ? 3000 : 1500;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: buildPlanPrompt(title, description) }],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error("Failed to generate goal plan");
  }

  const raw = block.text
    .replace(/```(?:json)?\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  return JSON.parse(raw) as GoalPlan;
}

function formatPlanForUser(title: string, plan: GoalPlan): string {
  const lines: string[] = [`Here's my plan for "${title}":\n`];

  if (plan.milestones.length > 0) {
    lines.push("Milestones:");
    for (const m of plan.milestones) {
      const date = new Date(m.targetDate).toLocaleDateString("en-US", {
        timeZone: TIMEZONE,
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      lines.push(`  - ${m.text} (${date})`);
    }
    lines.push("");
  }

  if (plan.habits.length > 0) {
    lines.push("Habits to build:");
    for (const h of plan.habits) {
      const freq = h.frequencyPerWeek === 7 ? "daily" : `${h.frequencyPerWeek}x/week`;
      lines.push(`  - ${h.text} (${freq})`);
    }
    lines.push("");
  }

  if (plan.commitments.length > 0) {
    lines.push("Immediate tasks:");
    for (const c of plan.commitments) {
      const date = new Date(c.deadline).toLocaleDateString("en-US", {
        timeZone: TIMEZONE,
        month: "short",
        day: "numeric",
      });
      lines.push(`  - ${c.text} (by ${date})`);
    }
    lines.push("");
  }

  if (plan.calendarEvents.length > 0) {
    lines.push("Scheduled blocks:");
    for (const e of plan.calendarEvents) {
      const recLabel = e.recurrence ? " (recurring)" : "";
      lines.push(`  - ${e.summary}${recLabel}`);
    }
    lines.push("");
  }

  lines.push("Want me to create this plan? You can also ask me to adjust anything.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core goal functions
// ---------------------------------------------------------------------------

export async function createGoalWithPlan(
  chatId: string,
  title: string,
  description?: string,
  rawMessage?: string,
): Promise<{ goal: { id: string; title: string }; planSummary: string }> {
  const goal = await prisma.goal.create({
    data: { chatId, title, description, status: "planning" },
  });

  // Use the full raw message as context for plan generation so nothing gets
  // lost through the intent parser's token limit. Fall back to parsed description.
  const plan = await generateGoalPlan(title, rawMessage ?? description);

  await prisma.goal.update({
    where: { id: goal.id },
    data: { plan: JSON.parse(JSON.stringify(plan)) },
  });

  const planSummary = formatPlanForUser(title, plan);
  setGoalPlanningState(chatId, goal.id, title, planSummary);

  return { goal: { id: goal.id, title: goal.title }, planSummary };
}

export async function approveGoalPlan(
  goalId: string,
  chatId: string,
): Promise<{ summary: string }> {
  const goal = await prisma.goal.findUniqueOrThrow({
    where: { id: goalId },
  });

  const plan = goal.plan as unknown as GoalPlan;
  if (!plan) throw new Error("No plan found for goal");

  const created = { milestones: 0, habits: 0, commitments: 0, calendarEvents: 0 };

  // Create milestones
  for (const m of plan.milestones) {
    await prisma.milestone.create({
      data: {
        goalId,
        text: m.text,
        targetDate: new Date(m.targetDate),
      },
    });
    created.milestones++;
  }

  // Create habits linked to goal
  for (const h of plan.habits) {
    await prisma.habit.create({
      data: {
        chatId,
        text: h.text,
        frequencyPerWeek: h.frequencyPerWeek,
        goalId,
      },
    });
    created.habits++;
  }

  // Create commitments linked to goal (uses existing function for BullMQ scheduling)
  for (const c of plan.commitments) {
    const commitment = await createCommitment(chatId, c.text, new Date(c.deadline));
    await prisma.commitment.update({
      where: { id: commitment.id },
      data: { goalId },
    });
    created.commitments++;
  }

  // Create calendar events
  for (const e of plan.calendarEvents) {
    try {
      await createCalendarEvent(
        e.summary,
        new Date(e.start),
        new Date(e.end),
        e.description ?? undefined,
        e.recurrence ?? undefined,
      );
      created.calendarEvents++;
    } catch (err) {
      logger.warn({ err, event: e.summary }, "Failed to create calendar event for goal");
    }
  }

  // Activate goal, clear draft plan
  await prisma.goal.update({
    where: { id: goalId },
    data: { status: "active", plan: undefined },
  });

  const parts: string[] = [`Goal "${goal.title}" is live.\n\nCreated:`];
  if (created.milestones > 0) parts.push(`  - ${created.milestones} milestones`);
  if (created.habits > 0) parts.push(`  - ${created.habits} habits`);
  if (created.commitments > 0) parts.push(`  - ${created.commitments} commitments`);
  if (created.calendarEvents > 0) parts.push(`  - ${created.calendarEvents} calendar events`);

  return { summary: parts.join("\n") };
}

export async function reviseGoalPlan(
  goalId: string,
  feedback: string,
): Promise<{ planSummary: string }> {
  const goal = await prisma.goal.findUniqueOrThrow({
    where: { id: goalId },
  });

  const currentPlan = goal.plan as unknown as GoalPlan;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: buildPlanPrompt(goal.title, goal.description ?? undefined),
      },
      {
        role: "assistant",
        content: JSON.stringify(currentPlan),
      },
      {
        role: "user",
        content: `Revise the plan based on this feedback: ${feedback}\n\nReturn the full revised plan as JSON in the same format.`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error("Failed to revise goal plan");
  }

  const raw = block.text
    .replace(/```(?:json)?\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  const revisedPlan = JSON.parse(raw) as GoalPlan;

  await prisma.goal.update({
    where: { id: goalId },
    data: { plan: JSON.parse(JSON.stringify(revisedPlan)) },
  });

  const planSummary = formatPlanForUser(goal.title, revisedPlan);

  // Update the planning state with new summary
  const chatId = goal.chatId;
  setGoalPlanningState(chatId, goalId, goal.title, planSummary);

  return { planSummary };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getActiveGoals(chatId: string) {
  return prisma.goal.findMany({
    where: { chatId, status: "active" },
    include: {
      milestones: { orderBy: { targetDate: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function formatGoalsOverview(chatId: string): Promise<string> {
  const goals = await prisma.goal.findMany({
    where: { chatId, status: { in: ["active", "planning", "paused"] } },
    include: {
      milestones: { orderBy: { targetDate: "asc" } },
      habits: { where: { active: true } },
      commitments: { where: { status: "pending" } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (goals.length === 0) return "No active goals.";

  const lines: string[] = ["Your goals:\n"];

  for (const goal of goals) {
    const completedMilestones = goal.milestones.filter((m) => m.status === "completed").length;
    const totalMilestones = goal.milestones.length;
    const statusLabel = goal.status === "paused" ? " (paused)" : goal.status === "planning" ? " (pending approval)" : "";

    lines.push(`${goal.title}${statusLabel}`);

    if (totalMilestones > 0) {
      const pct = Math.round((completedMilestones / totalMilestones) * 100);
      lines.push(`  Milestones: ${completedMilestones}/${totalMilestones} (${pct}%)`);

      const nextMilestone = goal.milestones.find((m) => m.status === "pending");
      if (nextMilestone) {
        const dateLabel = nextMilestone.targetDate
          ? ` — ${nextMilestone.targetDate.toLocaleDateString("en-US", { timeZone: TIMEZONE, month: "short", day: "numeric" })}`
          : "";
        lines.push(`  Next: ${nextMilestone.text}${dateLabel}`);
      }
    }

    if (goal.habits.length > 0) {
      lines.push(`  Habits: ${goal.habits.map((h) => h.text).join(", ")}`);
    }

    if (goal.commitments.length > 0) {
      lines.push(`  Pending tasks: ${goal.commitments.length}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Goal status updates
// ---------------------------------------------------------------------------

export async function updateGoalStatus(
  chatId: string,
  goalTitle: string,
  action: "complete" | "abandon",
) {
  const goal = await prisma.goal.findFirst({
    where: {
      chatId,
      status: "active",
      title: { contains: goalTitle, mode: "insensitive" },
    },
    include: { habits: { where: { active: true } } },
  });

  if (!goal) return null;

  const newStatus = action === "complete" ? "completed" : "abandoned";

  await prisma.goal.update({
    where: { id: goal.id },
    data: { status: newStatus },
  });

  // Deactivate linked habits when goal is completed or abandoned
  if (goal.habits.length > 0) {
    await prisma.habit.updateMany({
      where: { goalId: goal.id, active: true },
      data: { active: false },
    });
  }

  return { title: goal.title };
}

export async function completeMilestone(chatId: string, milestoneText: string) {
  const milestone = await prisma.milestone.findFirst({
    where: {
      status: "pending",
      text: { contains: milestoneText, mode: "insensitive" },
      goal: { chatId, status: "active" },
    },
    include: { goal: true },
  });

  if (!milestone) return null;

  await prisma.milestone.update({
    where: { id: milestone.id },
    data: { status: "completed", completedAt: new Date() },
  });

  return { text: milestone.text, goalTitle: milestone.goal.title };
}
