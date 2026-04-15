import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db/prisma.js";
import { listUpcomingEvents } from "./calendar.js";
import { getTodaysDueCommitments, getTodaysHabitStatus } from "./accountability.js";
import { getActiveGoals } from "./goals.js";
import { getTimezone } from "../lib/settings.js";

const anthropic = new Anthropic();

export async function getDailyBrief(chatId: string): Promise<string> {
  const tz = await getTimezone(chatId);

  function formatDate(date: Date): string {
    return date.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const [reminders, listItems, calendarEvents, dueCommitments, habitStatus, activeGoals] =
    await Promise.all([
      prisma.reminder.findMany({
        where: {
          chatId,
          fireAt: { gt: now, lt: tomorrow },
          fired: false,
          cancelled: false,
        },
        orderBy: { fireAt: "asc" },
      }),
      prisma.listItem.findMany({
        where: { chatId, done: false },
        orderBy: { createdAt: "asc" },
      }),
      listUpcomingEvents(1),
      getTodaysDueCommitments(chatId),
      getTodaysHabitStatus(chatId),
      getActiveGoals(chatId),
    ]);

  const reminderText =
    reminders.length > 0
      ? reminders.map((r) => `- ${r.text} (${formatDate(r.fireAt)})`).join("\n")
      : "No upcoming reminders today.";

  const listsByName = new Map<string, string[]>();
  for (const item of listItems) {
    const list = listsByName.get(item.listName) ?? [];
    list.push(item.text);
    listsByName.set(item.listName, list);
  }

  const listsText =
    listsByName.size > 0
      ? Array.from(listsByName.entries())
          .map(([name, items]) => `${name}: ${items.join(", ")}`)
          .join("\n")
      : "No active lists.";

  const commitmentText =
    dueCommitments.length > 0
      ? dueCommitments
          .map((c) => `- ${c.text} (due ${formatDate(c.deadline)})`)
          .join("\n")
      : "No commitments due today.";

  const habitText =
    habitStatus.length > 0
      ? habitStatus
          .map(
            (h) =>
              `- ${h.habit.text}: ${h.completionsThisWeek}/${h.target} this week${h.completedToday ? " (done today)" : ""}`,
          )
          .join("\n")
      : "No active habits.";

  const goalText =
    activeGoals.length > 0
      ? activeGoals
          .map((g) => {
            const done = g.milestones.filter((m) => m.status === "completed").length;
            const total = g.milestones.length;
            const next = g.milestones.find((m) => m.status === "pending");
            const nextLabel = next
              ? ` — Next: ${next.text}${next.targetDate ? ` (${next.targetDate.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })})` : ""}`
              : "";
            return `- ${g.title}: ${done}/${total} milestones${nextLabel}`;
          })
          .join("\n")
      : "";

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `You are summarising today's context for the user. Be concise and friendly.
Format as a clean WhatsApp-style message with emoji. Max 300 words.

Upcoming reminders:\n${reminderText}

Calendar events today:\n${calendarEvents}

Active lists:\n${listsText}

Commitments due today:\n${commitmentText}

Habits to work on:\n${habitText}${goalText ? `\n\nActive goals:\n${goalText}` : ""}`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    return "Could not generate today's briefing.";
  }

  return block.text;
}
