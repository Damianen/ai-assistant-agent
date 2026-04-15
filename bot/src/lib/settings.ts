import { prisma } from "../db/prisma.js";

const DEFAULT_TIMEZONE = "Europe/Amsterdam";

const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.YOUR_CHAT_ID;

export async function getTimezone(overrideChatId?: string): Promise<string> {
  const id = overrideChatId ?? chatId;
  if (!id) return DEFAULT_TIMEZONE;
  const settings = await prisma.userSettings.findUnique({
    where: { chatId: id },
  });
  return settings?.timezone ?? DEFAULT_TIMEZONE;
}
