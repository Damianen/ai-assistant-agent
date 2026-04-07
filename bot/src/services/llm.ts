import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const anthropic = new Anthropic();

const TIMEZONE = "Europe/Amsterdam";

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

const CreateCalendarEventSchema = z.object({
  intent: z.literal("create_calendar_event"),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  description: z.string().optional(),
});

const QueryCalendarSchema = z.object({
  intent: z.literal("query_calendar"),
  days: z.number(),
});

const DailyBriefSchema = z.object({
  intent: z.literal("daily_brief"),
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
  CreateCalendarEventSchema,
  QueryCalendarSchema,
  DailyBriefSchema,
  UnknownSchema,
]);

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

function buildSystemPrompt(): string {
  const now = new Date().toLocaleDateString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `You are a personal assistant parser. Extract intent from the user message and return ONLY valid JSON with no explanation, no markdown, no backticks.

Today: ${now}
User timezone: ${TIMEZONE}

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

create_calendar_event:
{ "intent": "create_calendar_event", "summary": "string", "start": "ISO8601 string", "end": "ISO8601 string", "description": "string (optional)" }
If no end time is specified, default to 1 hour after start.
Use this for any request to add, create, or schedule a meeting, event, or appointment on the calendar. Do NOT use create_memory for calendar events.

query_calendar:
{ "intent": "query_calendar", "days": number }
Use this when the user wants to check, view, or list their calendar events. "days" is how far ahead to look (1 = today, 7 = this week, 30 = this month).

daily_brief:
{ "intent": "daily_brief" }

unknown:
{ "intent": "unknown", "reply": "string (friendly response to the user)" }

Return ONLY the JSON object.`;
}

export async function parseIntent(message: string): Promise<ParsedIntent> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: message }],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    return { intent: "unknown", reply: "I had trouble understanding that, try again" };
  }

  const raw = block.text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    const parsed = JSON.parse(raw);
    const result = ParsedIntentSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    return { intent: "unknown", reply: "I had trouble understanding that, try again" };
  } catch {
    return { intent: "unknown", reply: "I had trouble understanding that, try again" };
  }
}
