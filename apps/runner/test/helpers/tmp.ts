import { rmSync } from "node:fs";

/**
 * Removes a test's temporary tree, best effort. On Windows a child that was just killed holds
 * its directory for a moment (EBUSY), so the removal retries; and a leftover under the system's
 * temp dir is not a failure of the thing under test.
 */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // best effort
  }
}
