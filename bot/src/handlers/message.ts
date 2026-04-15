import type { Context } from "grammy";
import { parseIntent, type ChatHistoryMessage, type CheckInContext, type GoalPlanningContext } from "../services/llm.js";
import { createReminder } from "../services/reminders.js";
import { getDailyBrief } from "../services/briefing.js";
import { createCalendarEvent, listUpcomingEvents, getAuthUrl, COLOR_NAME_TO_ID, CALENDAR_COLORS, findEventBySearch, updateCalendarEvent } from "../services/calendar.js";
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
import {
  createGoalWithPlan,
  approveGoalPlan,
  reviseGoalPlan,
  getGoalPlanningState,
  clearGoalPlanningState,
  formatGoalsOverview,
  completeMilestone,
  updateGoalStatus,
} from "../services/goals.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";
import { getTimezone } from "../lib/settings.js";

const HISTORY_LIMIT = 20;

async function formatDate(date: Date, chatId: string): Promise<string> {
  const tz = await getTimezone(chatId);
  return date.toLocaleString("en-US", {
    timeZone: tz,
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

  // Check for goal planning state (only if not in a check-in)
  let goalPlanningContext: GoalPlanningContext | undefined;
  if (!checkInContext) {
    const goalState = getGoalPlanningState(chatId);
    if (goalState) {
      goalPlanningContext = { goalTitle: goalState.goalTitle };
    }
  }

  const intent = await parseIntent(text, history, checkInContext, goalPlanningContext, chatId);

  switch (intent.intent) {
    case "create_reminder": {
      const fireAt = new Date(intent.datetime);
      await createReminder(chatId, intent.text, fireAt, intent.recurrence);
      await reply(
        `Got it! I'll remind you to ${intent.text} on ${await formatDate(fireAt, chatId)}`,
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
        const results: string[] = [];
        for (const event of intent.events) {
          const colorId = event.color ? COLOR_NAME_TO_ID[event.color] ?? null : null;
          const link = await createCalendarEvent(
            event.summary,
            new Date(event.start),
            new Date(event.end),
            event.description,
            event.recurrence,
            colorId,
            chatId,
          );
          const label = event.recurrence
            ? `Recurring event created: ${event.summary}`
            : `Event created: ${event.summary}`;
          results.push(`${label}\n${link}`);
        }
        await reply(results.join("\n\n"));
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

    case "edit_calendar_event": {
      try {
        const results: string[] = [];
        for (const edit of intent.edits) {
          const event = await findEventBySearch(edit.searchText);
          if (!event) {
            results.push(`Couldn't find an upcoming event matching "${edit.searchText}".`);
            continue;
          }

          const colorId = edit.updates.color
            ? COLOR_NAME_TO_ID[edit.updates.color] ?? undefined
            : undefined;

          const link = await updateCalendarEvent(event.id, {
            summary: edit.updates.summary,
            start: edit.updates.start ? new Date(edit.updates.start) : undefined,
            end: edit.updates.end ? new Date(edit.updates.end) : undefined,
            description: edit.updates.description,
            colorId,
          });

          const changes: string[] = [];
          if (edit.updates.summary) changes.push(`renamed to "${edit.updates.summary}"`);
          if (edit.updates.start) changes.push(`moved to ${await formatDate(new Date(edit.updates.start), chatId)}`);
          if (edit.updates.color) changes.push(`color set to ${edit.updates.color}`);
          const changeLabel = changes.length > 0 ? changes.join(", ") : "updated";

          results.push(`"${event.summary}" ${changeLabel}\n${link}`);
        }
        await reply(results.join("\n\n"));
      } catch (err) {
        if (err instanceof Error && err.message === "CALENDAR_NOT_CONNECTED") {
          const url = getAuthUrl();
          await reply(`I need access to your Google Calendar first.\nPlease authorize here: ${url}`);
        } else {
          throw err;
        }
      }
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

    case "set_timezone": {
      await prisma.userSettings.upsert({
        where: { chatId },
        create: { chatId, timezone: intent.timezone },
        update: { timezone: intent.timezone },
      });
      await reply(`Timezone set to ${intent.timezone}`);
      break;
    }

    case "set_event_color": {
      const colorId = COLOR_NAME_TO_ID[intent.color];
      if (!colorId) {
        const available = Object.values(CALENDAR_COLORS).join(", ");
        await reply(`Unknown color "${intent.color}". Available: ${available}`);
        break;
      }
      await prisma.calendarColorPreference.upsert({
        where: { chatId_category: { chatId, category: intent.category.toLowerCase() } },
        create: { chatId, category: intent.category.toLowerCase(), colorId },
        update: { colorId },
      });
      await reply(`Events matching "${intent.category}" will now be ${intent.color}`);
      break;
    }

    case "create_commitment": {
      const deadline = new Date(intent.deadline);
      await createCommitment(chatId, intent.text, deadline);
      await reply(
        `Locked in. I'll hold you to "${intent.text}" by ${await formatDate(deadline, chatId)}.`,
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
          `Rescheduled "${match.text}" to ${await formatDate(newDeadline, chatId)}. Don't let it slip again.`,
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

    case "create_goal": {
      await ctx.replyWithChatAction("typing");
      const { planSummary } = await createGoalWithPlan(
        chatId,
        intent.title,
        intent.description,
        text,
      );
      await reply(planSummary);
      enrichContextForMessage(text).catch(() => {});
      break;
    }

    case "approve_goal_plan": {
      await ctx.replyWithChatAction("typing");
      const goalState = getGoalPlanningState(chatId);
      if (!goalState) {
        await reply("No pending goal plan to approve.");
        break;
      }
      const { summary } = await approveGoalPlan(goalState.goalId, chatId);
      clearGoalPlanningState(chatId);
      await reply(summary);
      break;
    }

    case "revise_goal_plan": {
      await ctx.replyWithChatAction("typing");
      const goalState = getGoalPlanningState(chatId);
      if (!goalState) {
        await reply("No pending goal plan to revise.");
        break;
      }
      const { planSummary: revised } = await reviseGoalPlan(
        goalState.goalId,
        intent.feedback,
      );
      await reply(revised);
      break;
    }

    case "query_goals": {
      const goalsOverview = await formatGoalsOverview(chatId);
      await reply(goalsOverview);
      break;
    }

    case "update_goal": {
      const goalResult = await updateGoalStatus(
        chatId,
        intent.goalTitle,
        intent.action,
      );
      if (goalResult) {
        await reply(
          `Goal "${goalResult.title}" marked as ${intent.action}.`,
        );
      } else {
        await reply(
          `Couldn't find an active goal matching "${intent.goalTitle}".`,
        );
      }
      break;
    }

    case "complete_milestone": {
      const milestoneResult = await completeMilestone(
        chatId,
        intent.milestoneText,
      );
      if (milestoneResult) {
        await reply(
          `Milestone "${milestoneResult.text}" completed for "${milestoneResult.goalTitle}".`,
        );
      } else {
        await reply(
          `Couldn't find a pending milestone matching "${intent.milestoneText}".`,
        );
      }
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

