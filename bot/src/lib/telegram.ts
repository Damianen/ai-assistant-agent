import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather on Telegram."
  );
}

export const bot = new Bot(token);
