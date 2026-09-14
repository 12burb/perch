/**
 * ports.list and ports.changed (spec §7.6, §5.6 "auto-detect ports", task 1.5): the TCP ports a
 * machine is listening on, from /proc on Linux (pids for the runner's own processes), lsof on macOS,
 * netstat on Windows; a poller notifies the api when the set changes.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { platform } from "node:os";
import type { RunnerNotification } from "@perch/events";

export type ListeningPort = { port: number; pid?: number };

/** inode → pid for processes whose /proc/<pid>/fd is readable (the runner's own user). */
function socketOwners(): Map<string, number> {
  const owners = new Map<string, number>();
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return owners;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match?.[1]) owners.set(match[1], Number(pid));
      } catch {
        // gone or unreadable
      }
    }
  }
  return owners;
}

const LISTEN = "0A";

export function parseProcNetTcp(text: string, owners: Map<string, number>): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    const local = cols[1];
    const state = cols[3];
    const inode = cols[9];
    if (!local || state !== LISTEN) continue;
    const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
    if (!port) continue;
    const pid = inode ? owners.get(inode) : undefined;
    out.push(pid === undefined ? { port } : { port, pid });
  }
  return out;
}

function listLinux(): ListeningPort[] {
  const owners = socketOwners();
  const out: ListeningPort[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      out.push(...parseProcNetTcp(readFileSync(file, "utf8"), owners));
    } catch {
      // no such table on this kernel
    }
  }
  return out;
}

export function parseLsof(text: string): ListeningPort[] {
  const out: ListeningPort[] = [];
  let pid: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (port) out.push(pid === undefined ? { port } : { port, pid });
    }
  }
  return out;
}

function listDarwin(): ListeningPort[] {
  const proc = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]);
  return proc.exitCode === 0 ? parseLsof(proc.stdout.toString()) : [];
}

export function parseNetstat(text: string): ListeningPort[] {
  const out: ListeningPort[] = [];
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    const local = cols[1] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    const pid = Number(cols[4]);
    if (port) out.push(Number.isFinite(pid) && pid > 0 ? { port, pid } : { port });
  }
  return out;
}

function listWindows(): ListeningPort[] {
  const proc = Bun.spawnSync(["netstat", "-ano", "-p", "tcp"]);
  return proc.exitCode === 0 ? parseNetstat(proc.stdout.toString()) : [];
}

/** One entry per port (the lowest pid wins), ascending. */
export function dedupe(ports: ListeningPort[]): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const entry of ports) {
    const seen = byPort.get(entry.port);
    if (!seen || (entry.pid !== undefined && (seen.pid === undefined || entry.pid < seen.pid))) {
      byPort.set(entry.port, entry);
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export async function listPorts(): Promise<ListeningPort[]> {
  switch (platform()) {
    case "linux":
      return dedupe(listLinux());
    case "darwin":
      return dedupe(listDarwin());
    case "win32":
      return dedupe(listWindows());
    default:
      return [];
  }
}

function key(ports: ListeningPort[]): string {
  return ports.map((p) => `${p.port}:${p.pid ?? ""}`).join(",");
}

/**
 * Polls the listening ports and emits ports.changed with the whole list: once on the first look (so
 * the api knows the state at connect) and then whenever it changes.
 */
export function watchPorts(
  emit: (notification: RunnerNotification) => void,
  options: { intervalMs?: number; list?: () => Promise<ListeningPort[]> } = {},
): () => void {
  const list = options.list ?? listPorts;
  let last: string | null = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const ports = await list();
      const now = key(ports);
      if (now !== last) emit({ method: "ports.changed", params: { ports } });
      last = now;
    } catch {
      // a transient failure to read the tables; try again next tick
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs ?? 2_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
