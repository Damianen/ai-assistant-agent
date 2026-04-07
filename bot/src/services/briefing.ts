import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db/prisma.js";
import { listUpcomingEvents } from "./calendar.js";

const anthropic = new Anthropic();
const TIMEZONE = "Europe/Amsterdam";

function formatDate(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function getDailyBrief(chatId: string): Promise<string> {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const [reminders, listItems, calendarEvents] = await Promise.all([
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

Active lists:\n${listsText}`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    return "Could not generate today's briefing.";
  }

  return block.text;
}
