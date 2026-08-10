import type { BaseMessageLike } from "@langchain/core/messages";

const MIN_INTERVAL_MS = 13_000;
let lastCallAt = 0;

export interface CallableModel {
  invoke(messages: BaseMessageLike[]): Promise<unknown>;
}

export async function modelCall(
  model: CallableModel,
  messages: BaseMessageLike[],
): Promise<unknown> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const result = await model.invoke(messages);
      lastCallAt = Date.now();
      return result;
    } catch (err) {
      const message = (err as Error).message ?? "";
      const isRateLimit = message.includes("429") || /quota|rate.?limit/i.test(message);
      if (!isRateLimit || attempt === 6) throw err;

      const delayMatch = message.match(/retryDelay:\s*'?(\d+)s/);
      const delay = delayMatch ? Number(delayMatch[1]) * 1000 : 10_000 + attempt * 5_000;
      console.warn(`  (rate limited, retrying in ${Math.round(delay / 1000)}s)`);
      await new Promise((r) => setTimeout(r, delay));
      lastCallAt = Date.now();
    }
  }
  throw new Error("unreachable");
}
