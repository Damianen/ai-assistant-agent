import { google } from "googleapis";
import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TIMEZONE = "Europe/Amsterdam";

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

export function getAuthUrl(): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

export async function handleOAuthCallback(code: string): Promise<void> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
    throw new Error("Incomplete token response from Google");
  }

  const existing = await prisma.calendarTokens.findFirst();
  const data = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date),
  };

  if (existing) {
    await prisma.calendarTokens.update({ where: { id: existing.id }, data });
  } else {
    await prisma.calendarTokens.create({ data });
  }

  logger.info("Google Calendar tokens stored");
}

async function getAuthedClient() {
  const tokens = await prisma.calendarTokens.findFirst();
  if (!tokens) return null;

  const client = createOAuth2Client();
  client.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAt.getTime(),
  });

  client.on("tokens", async (refreshed) => {
    try {
      await prisma.calendarTokens.update({
        where: { id: tokens.id },
        data: {
          accessToken: refreshed.access_token ?? tokens.accessToken,
          expiresAt: refreshed.expiry_date
            ? new Date(refreshed.expiry_date)
            : tokens.expiresAt,
        },
      });
      logger.info("Calendar tokens refreshed");
    } catch (err) {
      logger.error({ err }, "Failed to persist refreshed calendar tokens");
    }
  });

  return client;
}

function formatEventTime(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  return d.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function createCalendarEvent(
  summary: string,
  start: Date,
  end: Date,
  description?: string,
  recurrence?: string | null,
): Promise<string> {
  const auth = await getAuthedClient();
  if (!auth) throw new Error("CALENDAR_NOT_CONNECTED");

  const calendar = google.calendar({ version: "v3", auth });
  const event = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      ...(recurrence ? { recurrence: [recurrence] } : {}),
    },
  });

  return event.data.htmlLink ?? "Event created (no link available)";
}

export async function listUpcomingEvents(days: number): Promise<string> {
  const auth = await getAuthedClient();
  if (!auth) return "Calendar not connected.";

  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const events = res.data.items ?? [];
  if (events.length === 0) return "No upcoming events.";

  return events
    .map((e) => {
      const start = e.start?.dateTime ?? e.start?.date ?? "?";
      return `- ${e.summary ?? "(no title)"} (${formatEventTime(start)})`;
    })
    .join("\n");
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const auth = await getAuthedClient();
  if (!auth) throw new Error("CALENDAR_NOT_CONNECTED");

  const calendar = google.calendar({ version: "v3", auth });
  await calendar.events.delete({ calendarId: "primary", eventId });
}
