import type { Context } from "grammy";
import { parseIntent, type ChatHistoryMessage, type CheckInContext } from "../services/llm.js";
import { createReminder } from "../services/reminders.js";
import { getDailyBrief } from "../services/briefing.js";
import { createCalendarEvent, listUpcomingEvents, getAuthUrl } from "../services/calendar.js";
import { processWithBrain, enrichContextForMessage } from "../services/brain.js";
import {
  createCommitment,
  completeCommitment,
  rescheduleCommitment,
  cancelCommitment,
  createHabit,
  deactivateHabit,
  skipHabitToday,
  getCheckInState,
  getCheckInItems,
  clearCheckInState,
  processCheckInResponse,
  updateAccountabilitySettings,
  formatCommitmentsOverview,
  formatHabitsOverview,
  formatAccountabilityStats,
} from "../services/accountability.js";
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

  // Check if we're in an active check-in conversation
  let checkInContext: CheckInContext | undefined;
  const checkInState = getCheckInState(chatId);
  if (checkInState) {
    if (checkInState.mode === "post_meeting" && checkInState.eventSummary) {
      checkInContext = { items: [], postMeetingEvent: checkInState.eventSummary };
    } else {
      const items = await getCheckInItems(chatId, checkInState);
      if (items.length > 0) {
        checkInContext = { items };
      }
    }
  }

  const intent = await parseIntent(text, history, checkInContext);

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

    case "set_calendar_reminder": {
      await prisma.userSettings.upsert({
        where: { chatId },
        create: { chatId, calendarReminderMinutes: intent.minutes },
        update: { calendarReminderMinutes: intent.minutes },
      });
      const msg =
        intent.minutes === 0
          ? "Calendar notifications disabled"
          : `Calendar notifications set to ${intent.minutes} minutes before`;
      await reply(msg);
      break;
    }

    case "create_commitment": {
      const deadline = new Date(intent.deadline);
      await createCommitment(chatId, intent.text, deadline);
      await reply(
        `Locked in. I'll hold you to "${intent.text}" by ${formatDate(deadline)}.`,
      );
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "create_habit": {
      await createHabit(chatId, intent.text, intent.frequencyPerWeek);
      const freq =
        intent.frequencyPerWeek === 7
          ? "daily"
          : `${intent.frequencyPerWeek}x/week`;
      await reply(`Tracking "${intent.text}" — ${freq}. I'll check in on this.`);
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "complete_commitment": {
      const commitment = await completeCommitment(chatId, intent.commitmentText);
      if (commitment) {
        await reply(`Nice — "${commitment.text}" marked as done.`);
      } else {
        await reply(
          `Couldn't find a pending commitment matching "${intent.commitmentText}".`,
        );
      }
      break;
    }

    case "reschedule_commitment": {
      const match = await prisma.commitment.findFirst({
        where: {
          chatId,
          status: "pending",
          text: { contains: intent.commitmentText, mode: "insensitive" },
        },
      });
      if (match) {
        const newDeadline = new Date(intent.newDeadline);
        await rescheduleCommitment(match.id, newDeadline);
        await reply(
          `Rescheduled "${match.text}" to ${formatDate(newDeadline)}. Don't let it slip again.`,
        );
      } else {
        await reply(
          `Couldn't find a pending commitment matching "${intent.commitmentText}".`,
        );
      }
      break;
    }

    case "accountability_checkin": {
      const results = await processCheckInResponse(chatId, intent.items);
      clearCheckInState(chatId);
      await reply(results.summary);
      break;
    }

    case "query_commitments": {
      const overview = await formatCommitmentsOverview(chatId);
      await reply(overview);
      break;
    }

    case "query_habits": {
      const overview = await formatHabitsOverview(chatId);
      await reply(overview);
      break;
    }

    case "cancel_commitment": {
      const result = await cancelCommitment(chatId, intent.commitmentText);
      if (result) {
        await reply(`Cancelled "${result.text}".`);
      } else {
        await reply(
          `Couldn't find a pending commitment matching "${intent.commitmentText}".`,
        );
      }
      break;
    }

    case "deactivate_habit": {
      const result = await deactivateHabit(chatId, intent.habitText);
      if (result) {
        await reply(`Stopped tracking "${result.text}".`);
      } else {
        await reply(
          `Couldn't find an active habit matching "${intent.habitText}".`,
        );
      }
      break;
    }

    case "query_accountability_stats": {
      const stats = await formatAccountabilityStats(chatId);
      await reply(stats);
      break;
    }

    case "post_meeting_action_items": {
      const created: string[] = [];
      for (const item of intent.items) {
        const deadline = new Date(item.deadline);
        await createCommitment(chatId, item.text, deadline);
        created.push(item.text);
      }
      clearCheckInState(chatId);
      if (created.length === 0) {
        await reply("No action items — noted.");
      } else {
        await reply(
          `Created ${created.length} commitment${created.length > 1 ? "s" : ""}:\n${created.map((t) => `- ${t}`).join("\n")}`,
        );
      }
      break;
    }

    case "skip_habit": {
      const result = await skipHabitToday(
        chatId,
        intent.habitText,
        intent.reason,
      );
      if (result) {
        const reasonLabel = intent.reason ? ` (${intent.reason})` : "";
        await reply(
          `Skipped "${result.text}" for today${reasonLabel}. Rest is part of the process.`,
        );
      } else {
        await reply(
          `Couldn't find an active habit matching "${intent.habitText}".`,
        );
      }
      break;
    }

    case "update_accountability_settings": {
      await updateAccountabilitySettings(
        chatId,
        intent.morningHour,
        intent.eveningHour,
      );
      const parts: string[] = [];
      if (intent.morningHour !== undefined)
        parts.push(`morning briefing → ${intent.morningHour}:00`);
      if (intent.eveningHour !== undefined)
        parts.push(`evening check-in → ${intent.eveningHour}:00`);
      await reply(`Updated: ${parts.join(", ")}`);
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

