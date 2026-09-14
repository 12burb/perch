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

export const SERVE_READY = "ready";

export function startLaptopInChild(options: ChildLaptopOptions): Promise<LaptopHandle> {
  const args = [
    ...selfCommand(),
    "--serve",
    "--port",
    String(options.port),
    "--public-url",
    options.publicUrl,
    "--log-level",
    options.logLevel,
    ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
  ];
  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
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
    const handleLine = (line: string) => {
      process.stdout.write(`${line}\n`);
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
    (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          handleLine(buffer.slice(0, newline).replace(/\r$/, ""));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer) handleLine(buffer);
    })().catch(() => {});
    void proc.exited.then((code) => {
      if (!ready) reject(new Error(`the server process exited with ${code} before it was ready`));
    });
  });
}
