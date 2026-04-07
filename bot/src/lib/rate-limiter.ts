const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

const windows = new Map<string, number[]>();

export function isRateLimited(chatId: string): boolean {
  const now = Date.now();
  const timestamps = windows.get(chatId) ?? [];

  // Drop timestamps outside the window
  const recent = timestamps.filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  windows.set(chatId, recent);

  return recent.length > MAX_PER_WINDOW;
}
