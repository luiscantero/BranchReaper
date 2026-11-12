import * as fs from "fs";

export interface RemoveResult {
  removed: boolean;
  attempts: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deletes a folder recursively, retrying with backoff for up to `totalMs` while it is in use
 * (Windows keeps folders with open handles, or in delete-pending state, around).
 */
export async function removeFolderWithRetry(dir: string, totalMs: number): Promise<RemoveResult> {
  const deadline = Date.now() + totalMs;
  let delay = 100;
  let attempts = 0;
  let lastError: string | undefined;
  for (;;) {
    attempts++;
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 0 });
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (!fs.existsSync(dir)) {
      return { removed: true, attempts };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { removed: false, attempts, error: lastError ?? "the folder still exists" };
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, 1000);
  }
}
