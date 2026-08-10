const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = {
  info: (...args: unknown[]) => console.log(`\x1b[36m${ts()}\x1b[0m`, ...args),
  ok: (...args: unknown[]) => console.log(`\x1b[32m${ts()} ✓\x1b[0m`, ...args),
  warn: (...args: unknown[]) => console.warn(`\x1b[33m${ts()} ⚠\x1b[0m`, ...args),
  error: (...args: unknown[]) => console.error(`\x1b[31m${ts()} ✗\x1b[0m`, ...args),
  http: (method: string, path: string, status: number, ms: number, user?: string) => {
    const color = status < 400 ? "\x1b[32m" : status < 500 ? "\x1b[33m" : "\x1b[31m";
    console.log(
      `\x1b[36m${ts()}\x1b[0m ${color}${method} ${path} ${status}\x1b[0m ${ms}ms${user ? ` [${user}]` : ""}`,
    );
  },
};
