import { writeFile, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Context } from "grammy";
import OpenAI from "openai";
import { processText } from "./message.js";
import { logger } from "../lib/logger.js";

const openai = new OpenAI();

export async function handleVoice(ctx: Context): Promise<void> {
  const voice = ctx.message?.voice;
  if (!voice) return;

  const tmpPath = `/tmp/voice-${voice.file_id}.ogg`;

  try {
    const file = await ctx.api.getFile(voice.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download voice file: ${res.status}`);
    }

    await writeFile(tmpPath, Buffer.from(await res.arrayBuffer()));

    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: createReadStream(tmpPath),
    });

    const transcript = transcription.text;
    if (!transcript) {
      await ctx.reply("Couldn't understand the audio, try again?");
      return;
    }

    await ctx.reply(`🎙️ I heard: ${transcript}`);
    await processText(ctx, transcript);
  } catch (err) {
    logger.error({ err, chatId: ctx.chat?.id }, "Voice handler error");
    await ctx.reply("Something went wrong processing your voice message 🔧");
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
