import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8"));

    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForPid(path: string, timeoutMs = 2000): Promise<number> {
  const deadline = performance.now() + timeoutMs;

  while (true) {
    const pid = readPid(path);

    if (pid !== undefined) {
      return pid;
    }

    if (performance.now() >= deadline) {
      throw new Error(`no pid in ${path} after ${timeoutMs}ms`);
    }

    await delay(20);
  }
}
