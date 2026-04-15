import type { Context } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db/prisma.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic();

export async function handlePhoto(ctx: Context): Promise<void> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) return;

  const chatId = ctx.chat?.id?.toString();
  if (!chatId) return;

  await ctx.replyWithChatAction("typing");

  try {
    // Telegram sends multiple sizes — pick the largest
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download photo: ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString("base64");

    // Determine media type from file extension
    const ext = file.file_path?.split(".").pop()?.toLowerCase() ?? "jpg";
    const mediaTypeMap: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mediaType = mediaTypeMap[ext] ?? "image/jpeg";

    const caption = ctx.message?.caption ?? "";

    // Fetch recent chat history for context
    const history = await prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const historyMessages = history
      .reverse()
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const userPrompt = caption
      ? `The user sent a photo with this caption: "${caption}"\n\nDescribe what you see and respond to their message.`
      : "The user sent a photo. Describe what you see and respond helpfully.";

    const messages: Anthropic.MessageParam[] = [
      ...historyMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: mediaType,
              data: base64,
            },
          },
          {
            type: "text" as const,
            text: userPrompt,
          },
        ],
      },
    ];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system:
        "You are a personal AI assistant. The user sent you an image via Telegram. Be helpful, concise, and natural in your response. If they asked a question about the image, answer it directly.",
      messages,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const reply = textBlock?.type === "text"
      ? textBlock.text
      : "I received your image but couldn't process it.";

    await ctx.reply(reply);

    // Store in chat history
    const userEntry = caption ? `[Photo] ${caption}` : "[Photo]";
    await prisma.chatMessage.create({
      data: { chatId, role: "user", content: userEntry },
    }).catch(() => {});
    await prisma.chatMessage.create({
      data: { chatId, role: "assistant", content: reply },
    }).catch(() => {});
  } catch (err) {
    logger.error({ err, chatId: ctx.chat?.id }, "Photo handler error");
    await ctx.reply("Something went wrong processing your image");
  }
}
