/**
 * A picture of a page the dev server is serving (spec §5.6 "Screenshot via headless Chromium in the
 * runner"; task 2.16).
 *
 * Headless Chromium is driven directly rather than through a library: `--screenshot` is what the
 * browser is for, and a runner that already has to ship a browser for the agent's eyes should not
 * also ship a second way of asking it for a picture (ADR-0108). Which browser is found in the
 * environment, so a laptop runner uses whatever Playwright already installed there.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class NoBrowser extends Error {
  constructor() {
    super("this runner has no headless browser; install Chromium or set PERCH_CHROMIUM");
    this.name = "NoBrowser";
  }
}

/** The candidates, nearest first: what the operator named, what Playwright put there, the PATH. */
export function browserCandidates(env: Record<string, string | undefined>): string[] {
  const named = [env.PERCH_CHROMIUM, env.PLAYWRIGHT_CHROMIUM_EXECUTABLE].filter(
    (one): one is string => Boolean(one),
  );
  const known = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return [...named, ...known];
}

export function findBrowser(env: Record<string, string | undefined> = process.env): string | null {
  for (const candidate of browserCandidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type ScreenshotInput = {
  port: number;
  path: string;
  width?: number | undefined;
  height?: number | undefined;
};

/**
 * One page, one PNG, base64 so it rides the §7.6 socket like every other answer. The browser is
 * given nothing but the URL: no profile, no extensions, no network beyond the machine it is on.
 */
export async function screenshot(
  input: ScreenshotInput,
  options: { browser?: string | undefined; timeoutMs?: number } = {},
): Promise<{ png: string; width: number; height: number }> {
  const browser = options.browser ?? findBrowser();
  if (!browser) throw new NoBrowser();
  const width = input.width ?? 1280;
  const height = input.height ?? 800;
  const dir = mkdtempSync(join(tmpdir(), "perch-shot-"));
  const out = join(dir, "shot.png");
  const url = `http://127.0.0.1:${input.port}${input.path.startsWith("/") ? input.path : `/${input.path}`}`;
  try {
    const proc = Bun.spawn(
      [
        browser,
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        `--window-size=${width},${height}`,
        `--screenshot=${out}`,
        "--virtual-time-budget=4000",
        url,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const finished = await Promise.race([
      proc.exited,
      Bun.sleep(options.timeoutMs ?? 30_000).then(() => "timeout" as const),
    ]);
    if (finished === "timeout") {
      proc.kill();
      throw new Error("the browser did not answer in time");
    }
    if (!existsSync(out)) {
      const why = (await new Response(proc.stderr).text()).trim().slice(-400);
      throw new Error(`the browser took no picture${why ? `: ${why}` : ""}`);
    }
    return { png: readFileSync(out).toString("base64"), width, height };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
