/**
 * Laptop mode in a child process of the same binary (`perch-desktop --serve`, ADR-0063). On Windows
 * the main thread owns the native run loop, so the server cannot share it; a process, not a worker
 * thread, because Bun's embedded worker entrypoints resolve to disk paths inside a compiled binary on
 * Windows. The child's output is forwarded line by line; it stops when its stdin closes.
 */
import type { LaptopHandle } from "./desktop.ts";
import { selfCommand } from "./self.ts";

export type ChildLaptopOptions = {
  dataDir?: string;
  port: number;
  publicUrl: string;
  logLevel: string;
};

export type Forward = (stream: "out" | "err", line: string) => void;

export const SERVE_READY = "ready";

export const serveArgs = (options: ChildLaptopOptions): string[] => [
  "--serve",
  "--port",
  String(options.port),
  "--public-url",
  options.publicUrl,
  "--log-level",
  options.logLevel,
  ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
];

async function forwardLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer) onLine(buffer);
}

/**
 * A `startLaptop` that runs `command --serve …` (this binary by default) and resolves once the child
 * prints its ready line. Every line the child writes is forwarded.
 */
export function childLaptopStarter(
  forward: Forward,
  command: () => string[] = selfCommand,
): (options: ChildLaptopOptions) => Promise<LaptopHandle> {
  return (options) => {
    const proc = Bun.spawn([...command(), ...serveArgs(options)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let stopping: Promise<void> | null = null;
    const stop = () => {
      stopping ??= (async () => {
        try {
          proc.stdin.end();
        } catch {
          // Already closed.
        }
        const exited = await Promise.race([
          proc.exited,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
        ]);
        if (exited === null) proc.kill();
        await proc.exited;
      })();
      return stopping;
    };
    return new Promise<LaptopHandle>((resolve, reject) => {
      let ready = false;
      const handleOut = (line: string) => {
        forward("out", line);
        if (ready) return;
        try {
          const parsed = JSON.parse(line) as { serve?: string; url?: string; dataDir?: string };
          if (parsed.serve === SERVE_READY && parsed.url && parsed.dataDir) {
            ready = true;
            resolve({ url: parsed.url, dataDir: parsed.dataDir, stop });
          }
        } catch {
          // Not the ready line (a log line, forwarded above).
        }
      };
      forwardLines(proc.stdout, handleOut).catch(() => {});
      forwardLines(proc.stderr, (line) => forward("err", line)).catch(() => {});
      void proc.exited.then((code) => {
        if (!ready) reject(new Error(`the server process exited with ${code} before it was ready`));
      });
    });
  };
}
