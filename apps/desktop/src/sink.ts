/**
 * Where the desktop app's lines go. A terminal or a pipe when one is attached; otherwise (the Windows
 * binary has no console window: double-clicked, nothing is attached and writes to stdout fail) a log
 * file under the data directory, rotated once when it grows past a few megabytes.
 */
import { existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

export type Sink = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** The log file in use, or null when the lines go to the process's own streams. */
  file: string | null;
};

export const LOG_FILE = join("desktop", "perch-desktop.log");
export const ROTATE_AT = 5 * 1024 * 1024;

const STD_OUTPUT_HANDLE = 0xffff_fff5; // (DWORD) -11
const STD_ERROR_HANDLE = 0xffff_fff4; // (DWORD) -12
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;

/** Windows: does this process have somewhere to write? A GUI process started by a click has not. */
export async function stdStreamsAttached(): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const { dlopen, FFIType } = await import("bun:ffi");
  const kernel32 = dlopen("kernel32.dll", {
    GetStdHandle: { args: [FFIType.u32], returns: FFIType.u64 },
  });
  const attached = (which: number) => {
    const handle = BigInt(kernel32.symbols.GetStdHandle(which));
    return handle !== 0n && handle !== INVALID_HANDLE_VALUE;
  };
  return attached(STD_OUTPUT_HANDLE) && attached(STD_ERROR_HANDLE);
}

export function streamSink(): Sink {
  return {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    file: null,
  };
}

export function fileSink(dataDir: string): Sink {
  const file = join(dataDir, LOG_FILE);
  mkdirSync(join(dataDir, "desktop"), { recursive: true });
  if (existsSync(file) && statSync(file).size > ROTATE_AT) renameSync(file, `${file}.1`);
  const fd = openSync(file, "a");
  const write = (stream: "out" | "err", line: string) => {
    try {
      writeSync(fd, `${new Date().toISOString()} ${stream} ${line}\n`);
    } catch {
      // A full disk must not take the app down.
    }
  };
  return { out: (line) => write("out", line), err: (line) => write("err", line), file };
}

export async function chooseSink(dataDir: string): Promise<Sink> {
  return (await stdStreamsAttached()) ? streamSink() : fileSink(dataDir);
}
