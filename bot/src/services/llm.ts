import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getTimezone } from "../lib/settings.js";

const anthropic = new Anthropic();

const CreateReminderSchema = z.object({
  intent: z.literal("create_reminder"),
  text: z.string(),
  datetime: z.string(),
  recurrence: z.string().nullable(),
});

const AddListItemSchema = z.object({
  intent: z.literal("add_list_item"),
  listName: z.string(),
  text: z.string(),
});

const QueryListSchema = z.object({
  intent: z.literal("query_list"),
  listName: z.string(),
});

const RemoveListItemSchema = z.object({
  intent: z.literal("remove_list_item"),
  listName: z.string(),
  text: z.string(),
});

const CreateMemorySchema = z.object({
  intent: z.literal("create_memory"),
  text: z.string(),
});

const RecallSchema = z.object({
  intent: z.literal("recall"),
  query: z.string(),
});

const DeleteMemorySchema = z.object({
  intent: z.literal("delete_memory"),
  query: z.string(),
});

const CalendarEventItem = z.object({
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  description: z.string().optional(),
  recurrence: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});

const CreateCalendarEventSchema = z.object({
  intent: z.literal("create_calendar_event"),
  events: z.array(CalendarEventItem),
});

const QueryCalendarSchema = z.object({
  intent: z.literal("query_calendar"),
  days: z.number(),
});

const SetCalendarReminderSchema = z.object({
  intent: z.literal("set_calendar_reminder"),
  minutes: z.number(),
});

const CreateCommitmentSchema = z.object({
  intent: z.literal("create_commitment"),
  text: z.string(),
  deadline: z.string(),
});

const CreateHabitSchema = z.object({
  intent: z.literal("create_habit"),
  text: z.string(),
  frequencyPerWeek: z.number(),
});

const CompleteCommitmentSchema = z.object({
  intent: z.literal("complete_commitment"),
  commitmentText: z.string(),
});

const RescheduleCommitmentSchema = z.object({
  intent: z.literal("reschedule_commitment"),
  commitmentText: z.string(),
  newDeadline: z.string(),
});

const AccountabilityCheckInSchema = z.object({
  intent: z.literal("accountability_checkin"),
  items: z.array(
    z.object({
      text: z.string(),
      completed: z.boolean(),
    }),
  ),
});

const UpdateAccountabilitySettingsSchema = z.object({
  intent: z.literal("update_accountability_settings"),
  morningHour: z.number().optional(),
  eveningHour: z.number().optional(),
});

const QueryCommitmentsSchema = z.object({
  intent: z.literal("query_commitments"),
});

const QueryHabitsSchema = z.object({
  intent: z.literal("query_habits"),
});

const CancelCommitmentSchema = z.object({
  intent: z.literal("cancel_commitment"),
  commitmentText: z.string(),
});

const DeactivateHabitSchema = z.object({
  intent: z.literal("deactivate_habit"),
  habitText: z.string(),
});

const QueryAccountabilityStatsSchema = z.object({
  intent: z.literal("query_accountability_stats"),
});

const PostMeetingActionItemsSchema = z.object({
  intent: z.literal("post_meeting_action_items"),
  items: z.array(
    z.object({
      text: z.string(),
      deadline: z.string(),
    }),
  ),
});

const SkipHabitSchema = z.object({
  intent: z.literal("skip_habit"),
  habitText: z.string(),
  reason: z.string().optional(),
});

const DailyBriefSchema = z.object({
  intent: z.literal("daily_brief"),
});

const CreateGoalSchema = z.object({
  intent: z.literal("create_goal"),
  title: z.string(),
  description: z.string().optional(),
});

const QueryGoalsSchema = z.object({
  intent: z.literal("query_goals"),
});

const UpdateGoalSchema = z.object({
  intent: z.literal("update_goal"),
  goalTitle: z.string(),
  action: z.enum(["complete", "abandon"]),
});

const CompleteMilestoneSchema = z.object({
  intent: z.literal("complete_milestone"),
  milestoneText: z.string(),
});

const ApproveGoalPlanSchema = z.object({
  intent: z.literal("approve_goal_plan"),
});

const ReviseGoalPlanSchema = z.object({
  intent: z.literal("revise_goal_plan"),
  feedback: z.string(),
});

const SetTimezoneSchema = z.object({
  intent: z.literal("set_timezone"),
  timezone: z.string(),
});

const SetEventColorSchema = z.object({
  intent: z.literal("set_event_color"),
  category: z.string(),
  color: z.string(),
});

const UnknownSchema = z.object({
  intent: z.literal("unknown"),
  reply: z.string(),
});

const ParsedIntentSchema = z.discriminatedUnion("intent", [
  CreateReminderSchema,
  AddListItemSchema,
  QueryListSchema,
  RemoveListItemSchema,
  CreateMemorySchema,
  RecallSchema,
  DeleteMemorySchema,
  CreateCalendarEventSchema,
  QueryCalendarSchema,
  SetCalendarReminderSchema,
  CreateCommitmentSchema,
  CreateHabitSchema,
  CompleteCommitmentSchema,
  RescheduleCommitmentSchema,
  AccountabilityCheckInSchema,
  UpdateAccountabilitySettingsSchema,
  QueryCommitmentsSchema,
  QueryHabitsSchema,
  CancelCommitmentSchema,
  DeactivateHabitSchema,
  QueryAccountabilityStatsSchema,
  PostMeetingActionItemsSchema,
  SkipHabitSchema,
  DailyBriefSchema,
  CreateGoalSchema,
  QueryGoalsSchema,
  UpdateGoalSchema,
  CompleteMilestoneSchema,
  ApproveGoalPlanSchema,
  ReviseGoalPlanSchema,
  SetTimezoneSchema,
  SetEventColorSchema,
  UnknownSchema,
]);

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

async function buildSystemPrompt(timezone: string): Promise<string> {
  const now = new Date().toLocaleDateString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `You are a personal assistant parser. Extract intent from the user's latest message. Use prior messages in the conversation for context when resolving references like "this", "that", "it", "same time", etc. Return ONLY valid JSON with no explanation, no markdown, no backticks.

Today: ${now}
User timezone: ${timezone}

Supported intents and their exact JSON shapes:

create_reminder:
{ "intent": "create_reminder", "text": "string", "datetime": "ISO8601 string", "recurrence": "cron string or null" }

add_list_item:
{ "intent": "add_list_item", "listName": "string (lowercase, e.g. shopping/todo/ideas)", "text": "string" }

query_list:
{ "intent": "query_list", "listName": "string" }

remove_list_item:
{ "intent": "remove_list_item", "listName": "string", "text": "string (partial match ok)" }

create_memory:
{ "intent": "create_memory", "text": "string (the fact to remember)" }

recall:
{ "intent": "recall", "query": "string (what to look up)" }

delete_memory:
{ "intent": "delete_memory", "query": "string (what to forget/remove)" }
Use this when the user asks to forget, remove, or delete something from memory (e.g. "forget about Sarah", "remove the info about my trip to Paris", "delete everything about X").

create_calendar_event:
{ "intent": "create_calendar_event", "events": [{ "summary": "string", "start": "ISO8601 string", "end": "ISO8601 string", "description": "string (optional)", "recurrence": "RRULE string or null", "color": "color name or null" }] }
The events array supports one or more events. If the user mentions multiple events, include them all.
Available colors: lavender, sage, grape, flamingo, banana, tangerine, peacock, graphite, blueberry, basil, tomato. Set color to null if the user doesn't specify one (the system will auto-apply based on their preferences).
If no end time is specified, default to 1 hour after start.
Use this for any request to add, create, or schedule a meeting, event, or appointment on the calendar. Do NOT use create_memory for calendar events.
If the user says "daily", "every day", "every weekday", "weekly", "every Monday", etc., extract a recurrence rule:
- "daily" / "every day" → "RRULE:FREQ=DAILY"
- "every weekday" → "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
- "weekly" / "every week" → "RRULE:FREQ=WEEKLY"
- "every Monday" → "RRULE:FREQ=WEEKLY;BYDAY=MO"
- "monthly" → "RRULE:FREQ=MONTHLY"
- With end date: append ";UNTIL=YYYYMMDDTHHMMSSZ"
If the event is not recurring, set recurrence to null.
For recurring events, set "start" to the first occurrence.

query_calendar:
{ "intent": "query_calendar", "days": number }
Use this when the user wants to check, view, or list their calendar events. "days" is how far ahead to look (1 = today, 7 = this week, 30 = this month).

set_calendar_reminder:
{ "intent": "set_calendar_reminder", "minutes": number }
Use this when the user wants to change how many minutes before a calendar event they get notified. Use 0 to disable notifications. Examples: "set calendar reminders to 10 minutes", "notify me 30 minutes before events", "turn off calendar notifications".

create_commitment:
{ "intent": "create_commitment", "text": "string (what they commit to)", "deadline": "ISO8601 string" }
Use when the user makes a commitment, promise, or pledge with a deadline. Examples: "I'll finish the report by Friday", "I commit to applying for 3 jobs this week", "I'm going to clean the house by Sunday".
IMPORTANT: This is different from create_reminder. Reminders are notifications ("remind me to..."). Commitments are personal accountability ("I'll do X by Y", "I promise to...", "I commit to...").

create_habit:
{ "intent": "create_habit", "text": "string (the habit)", "frequencyPerWeek": number }
Use when the user wants to build a recurring habit. Examples: "I want to exercise 3 times a week" (3), "I should meditate daily" (7), "I want to read twice a week" (2).

complete_commitment:
{ "intent": "complete_commitment", "commitmentText": "string (partial match ok)" }
Use when the user proactively says they finished a commitment. Examples: "I finished the report", "done with the job applications".

reschedule_commitment:
{ "intent": "reschedule_commitment", "commitmentText": "string (partial match ok)", "newDeadline": "ISO8601 string" }
Use when the user wants to push a commitment to a new deadline. Examples: "can I push the report to Monday?", "reschedule the cleaning to next week".

accountability_checkin:
{ "intent": "accountability_checkin", "items": [{ "text": "string", "completed": boolean }] }
Use ONLY when the user is responding to an accountability check-in message from the bot. Parse which items they completed vs didn't.

update_accountability_settings:
{ "intent": "update_accountability_settings", "morningHour": number (0-23, optional), "eveningHour": number (0-23, optional) }
Use when the user wants to change their morning briefing or evening check-in time. Examples: "set morning briefing to 7am", "change evening check-in to 10pm".

query_commitments:
{ "intent": "query_commitments" }
Use when the user wants to see their current commitments. Examples: "what are my commitments?", "show my pending commitments", "what did I commit to?".

query_habits:
{ "intent": "query_habits" }
Use when the user wants to see their habits and progress. Examples: "how are my habits going?", "show my habits", "what habits am I tracking?".

cancel_commitment:
{ "intent": "cancel_commitment", "commitmentText": "string (partial match ok)" }
Use when the user wants to cancel or drop a commitment entirely. Examples: "cancel my commitment to the report", "drop the gym goal", "I don't want to do the reading anymore".

deactivate_habit:
{ "intent": "deactivate_habit", "habitText": "string (partial match ok)" }
Use when the user wants to stop tracking a habit. Examples: "stop tracking exercise", "remove the meditation habit", "I don't want to track reading anymore".

query_accountability_stats:
{ "intent": "query_accountability_stats" }
Use when the user wants a summary of their accountability performance. Examples: "how did I do this week?", "show my stats", "what's my completion rate?", "how am I doing with my goals?".

post_meeting_action_items:
{ "intent": "post_meeting_action_items", "items": [{ "text": "string", "deadline": "ISO8601 string" }] }
Use ONLY when the user is responding to a post-meeting action items prompt. Extract each action item with a deadline. If no deadline mentioned, default to end of this week (Friday 17:00).

skip_habit:
{ "intent": "skip_habit", "habitText": "string (partial match ok)", "reason": "string (optional)" }
Use when the user wants to skip a habit for today as a rest day or intentional skip. Examples: "skip exercise today, rest day", "taking a break from meditation today", "skip running, I'm sick".

daily_brief:
{ "intent": "daily_brief" }

create_goal:
{ "intent": "create_goal", "title": "string (concise goal name)", "description": "string (optional extra context)" }
Use when the user sets a new goal or objective they want to work toward. Examples: "I want to quit smoking", "my goal is to launch a SaaS by December", "I want to run a marathon", "help me build a business", "I want to lose 10kg".
This is different from create_habit (a single recurring behavior) or create_commitment (a single task with deadline). Goals are bigger objectives that may involve multiple habits, commitments, and milestones.

query_goals:
{ "intent": "query_goals" }
Use when the user asks about their goals or goal progress. Examples: "how are my goals going?", "show my goals", "what goals do I have?".

update_goal:
{ "intent": "update_goal", "goalTitle": "string (partial match ok)", "action": "complete" | "abandon" }
Use when the user wants to mark a goal as achieved or give up on it. Examples: "I achieved my quit smoking goal", "abandon the business goal", "I'm done with the marathon goal".

complete_milestone:
{ "intent": "complete_milestone", "milestoneText": "string (partial match ok)" }
Use when the user says they've reached a milestone for a goal. Examples: "I've hit 1 week without smoking", "finished the MVP milestone", "completed the first phase".

set_timezone:
{ "intent": "set_timezone", "timezone": "string (IANA timezone, e.g. Europe/Amsterdam, America/New_York, Asia/Tokyo)" }
Use when the user wants to change their timezone. Examples: "set my timezone to US Eastern", "change timezone to Asia/Tokyo", "I'm in London now", "switch to Pacific time".

set_event_color:
{ "intent": "set_event_color", "category": "string (lowercase keyword, e.g. gym, meeting, dentist, work)", "color": "string (one of: lavender, sage, grape, flamingo, banana, tangerine, peacock, graphite, blueberry, basil, tomato)" }
Use when the user wants to set a default color for a type of calendar event. Examples: "make gym events green", "set meetings to blueberry", "color work events tomato", "use peacock for all dentist appointments".

unknown:
{ "intent": "unknown", "reply": "string (friendly response to the user)" }

Return ONLY the JSON object.`;
}

export interface CheckInContext {
  items: Array<{ id: string; text: string; type: "commitment" | "habit" }>;
  postMeetingEvent?: string;
}

export interface GoalPlanningContext {
  goalTitle: string;
}

export async function parseIntent(
  message: string,
  history: ChatHistoryMessage[] = [],
  checkInContext?: CheckInContext,
  goalPlanningContext?: GoalPlanningContext,
  chatId?: string,
): Promise<ParsedIntent> {
  const messages: ChatHistoryMessage[] = [
    ...history,
    { role: "user", content: message },
  ];

  const timezone = await getTimezone(chatId);
  let systemPrompt = await buildSystemPrompt(timezone);

  if (checkInContext?.postMeetingEvent) {
    systemPrompt += `\n\nIMPORTANT: The user is responding to a post-meeting action items prompt for "${checkInContext.postMeetingEvent}". Parse their response as a "post_meeting_action_items" intent. Extract each action item with a deadline. If no explicit deadline, default to this Friday at 17:00. If the user says "no", "nothing", or "none", return an empty items array.`;
  } else if (checkInContext && checkInContext.items.length > 0) {
    const itemList = checkInContext.items
      .map((i) => `- ${i.text} (${i.type})`)
      .join("\n");
    systemPrompt += `\n\nIMPORTANT: The user is currently responding to an accountability check-in. The following items were asked about:\n${itemList}\n\nParse their response as an "accountability_checkin" intent, mapping each item to completed: true/false based on what the user says. If they only mention some items, mark unmentioned ones as completed: false.`;
  } else if (goalPlanningContext) {
    systemPrompt += `\n\nIMPORTANT: The user is reviewing a proposed goal plan for "${goalPlanningContext.goalTitle}". If they approve it ("looks good", "yes", "go ahead", "create it", "perfect", "do it"), return { "intent": "approve_goal_plan" }. If they want changes ("change X", "remove Y", "add Z", "fewer milestones", etc.), return { "intent": "revise_goal_plan", "feedback": "their requested changes" }.`;
  }

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: systemPrompt,
    messages,
  });

  const block = response.content[0];
  if (block.type !== "text") {
    return { intent: "unknown", reply: "I had trouble understanding that, try again" };
  }

  const raw = block.text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    const parsed = JSON.parse(raw);

    // Normalize old flat calendar event format into events array
    if (parsed.intent === "create_calendar_event" && !parsed.events && parsed.summary) {
      parsed.events = [{
        summary: parsed.summary,
        start: parsed.start,
        end: parsed.end,
        description: parsed.description,
        recurrence: parsed.recurrence,
        color: parsed.color ?? null,
      }];
      delete parsed.summary;
      delete parsed.start;
      delete parsed.end;
      delete parsed.description;
      delete parsed.recurrence;
      delete parsed.color;
    }

    const result = ParsedIntentSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    return { intent: "unknown", reply: "I had trouble understanding that, try again" };
  } catch {
    return { intent: "unknown", reply: "I had trouble understanding that, try again" };
  }
}
