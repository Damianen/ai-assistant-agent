import type { Context } from "grammy";
import { parseIntent, type ChatHistoryMessage } from "../services/llm.js";
import { createReminder } from "../services/reminders.js";
import { getDailyBrief } from "../services/briefing.js";
import { createCalendarEvent, listUpcomingEvents, getAuthUrl } from "../services/calendar.js";
import { processWithBrain, enrichContextForMessage } from "../services/brain.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";

const TIMEZONE = "Europe/Amsterdam";
const HISTORY_LIMIT = 20;

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

async function getRecentHistory(chatId: string): Promise<ChatHistoryMessage[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { chatId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  // Ensure alternating roles (merge consecutive same-role messages)
  const ordered = rows.reverse();
  const result: ChatHistoryMessage[] = [];
  for (const row of ordered) {
    const role = row.role as "user" | "assistant";
    if (result.length > 0 && result[result.length - 1].role === role) {
      result[result.length - 1].content += "\n" + row.content;
    } else {
      result.push({ role, content: row.content });
    }
  }
  return result;
}

export async function processText(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  await ctx.replyWithChatAction("typing");

  // Fetch history before storing the current message
  const history = await getRecentHistory(chatId);

  // Store the incoming user message
  await prisma.chatMessage.create({
    data: { chatId, role: "user", content: text },
  });

  // Helper: reply to user and store the bot's response
  const reply = async (message: string) => {
    await ctx.reply(message);
    await prisma.chatMessage.create({
      data: { chatId, role: "assistant", content: message },
    }).catch(() => {}); // Don't fail the handler if storage fails
  };

  const intent = await parseIntent(text, history);

  switch (intent.intent) {
    case "create_reminder": {
      const fireAt = new Date(intent.datetime);
      await createReminder(chatId, intent.text, fireAt, intent.recurrence);
      await reply(
        `Got it! I'll remind you to ${intent.text} on ${formatDate(fireAt)}`,
      );
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "add_list_item": {
      await prisma.listItem.create({
        data: { chatId, listName: intent.listName, text: intent.text },
      });
      await reply(`Added '${intent.text}' to your ${intent.listName} list ✓`);
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "query_list": {
      const items = await prisma.listItem.findMany({
        where: { chatId, listName: intent.listName, done: false },
        orderBy: { createdAt: "asc" },
      });
      if (items.length === 0) {
        await reply(`Your ${intent.listName} list is empty`);
      } else {
        const formatted = items
          .map((item, i) => `${i + 1}. ${item.text}`)
          .join("\n");
        await reply(formatted);
      }
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "remove_list_item": {
      const item = await prisma.listItem.findFirst({
        where: {
          chatId,
          listName: intent.listName,
          text: { contains: intent.text, mode: "insensitive" },
          done: false,
        },
      });
      if (item) {
        await prisma.listItem.update({
          where: { id: item.id },
          data: { done: true },
        });
        await reply(`Removed from your ${intent.listName} list ✓`);
      } else {
        await reply(
          `Couldn't find '${intent.text}' in your ${intent.listName} list`,
        );
      }
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "create_memory": {
      await ctx.replyWithChatAction("typing");
      const brainReply = await processWithBrain(text, history);
      await reply(brainReply);
      break;
    }

    case "recall": {
      await ctx.replyWithChatAction("typing");
      const brainReply = await processWithBrain(text, history);
      await reply(brainReply);
      break;
    }

    case "delete_memory": {
      await ctx.replyWithChatAction("typing");
      const brainReply = await processWithBrain(text, history);
      await reply(brainReply);
      break;
    }

    case "create_calendar_event": {
      try {
        const link = await createCalendarEvent(
          intent.summary,
          new Date(intent.start),
          new Date(intent.end),
          intent.description,
          intent.recurrence,
        );
        const label = intent.recurrence
          ? `Recurring event created: ${intent.summary}`
          : `Event created: ${intent.summary}`;
        await reply(`${label}\n${link}`);
      } catch (err) {
        if (err instanceof Error && err.message === "CALENDAR_NOT_CONNECTED") {
          const url = getAuthUrl();
          await reply(
            `I need access to your Google Calendar first.\nPlease authorize here: ${url}`,
          );
        } else {
          throw err;
        }
      }
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "query_calendar": {
      const events = await listUpcomingEvents(intent.days);
      if (events === "Calendar not connected.") {
        const url = getAuthUrl();
        await reply(
          `I need access to your Google Calendar first.\nPlease authorize here: ${url}`,
        );
      } else {
        await reply(events);
      }
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "daily_brief": {
      const brief = await getDailyBrief(chatId);
      await reply(brief);
      break;
    }

    case "unknown": {
      await ctx.replyWithChatAction("typing");
      const brainReply = await processWithBrain(text, history);
      await reply(brainReply);
      break;
    }
  }
}

export async function handleMessage(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  try {
    await processText(ctx, text);
  } catch (err) {
    logger.error({ err, chatId: ctx.chat?.id }, "Message handler error");
    await ctx.reply("Something went wrong 🔧");
  }
}

