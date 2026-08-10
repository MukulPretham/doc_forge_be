const COOLDOWN_MS = 60 * 60 * 1000;

export interface ModelHealthStatus {
  available: boolean;
  reason?: string;
}

const state = new Map<string, { until: number; reason: string }>();

export function markQuotaExhausted(provider: string, model: string, reason: string) {
  state.set(`${provider}:${model}`, { until: Date.now() + COOLDOWN_MS, reason });
}

export function getModelHealth(provider: string, model: string): ModelHealthStatus {
  const entry = state.get(`${provider}:${model}`);
  if (!entry) return { available: true };
  if (Date.now() > entry.until) {
    state.delete(`${provider}:${model}`);
    return { available: true };
  }
  return { available: false, reason: entry.reason };
}
