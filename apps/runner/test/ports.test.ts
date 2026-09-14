import { describe, expect, test } from "bun:test";
import type { RunnerNotification } from "@perch/events";
import {
  dedupe,
  listPorts,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  watchPorts,
} from "../src/ports.ts";

/** Task 1.5: listening ports from the platform tables, and the watcher that reports changes. */

describe("ports (task 1.5)", () => {
  test("parses /proc/net/tcp listeners with pids from the socket inode map", () => {
    const text = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 999 1 0000000000000000 100 0 0 10 0
   2: 0100007F:A3F4 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 555 1 0000000000000000 20 4 30 10 -1
`;
    expect(parseProcNetTcp(text, new Map([["12345", 4242]]))).toEqual([
      { port: 8080, pid: 4242 },
      { port: 22 },
    ]);
  });

  test("parses lsof and netstat output", () => {
    expect(parseLsof("p100\nn*:5173\np200\nn127.0.0.1:3000\nn[::1]:3000\n")).toEqual([
      { port: 5173, pid: 100 },
      { port: 3000, pid: 200 },
      { port: 3000, pid: 200 },
    ]);
    expect(
      parseNetstat(`
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       5678
  TCP    127.0.0.1:49152        127.0.0.1:5173         ESTABLISHED     5678
`),
    ).toEqual([
      { port: 135, pid: 1234 },
      { port: 5173, pid: 5678 },
    ]);
  });

  test("dedupe keeps one entry per port, ascending, preferring a known pid", () => {
    expect(
      dedupe([{ port: 80 }, { port: 22, pid: 5 }, { port: 80, pid: 9 }, { port: 80, pid: 7 }]),
    ).toEqual([
      { port: 22, pid: 5 },
      { port: 80, pid: 7 },
    ]);
  });

  test("listPorts sees a port this process opens", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const ports = await listPorts();
      const mine = ports.find((p) => p.port === server.port);
      expect(mine, JSON.stringify(ports)).toBeDefined();
      if (process.platform === "linux") expect(mine?.pid).toBe(process.pid);
    } finally {
      server.stop(true);
    }
  });

  test("watchPorts reports the list on the first look, then whenever it changes, and stops", async () => {
    const lists = [
      [{ port: 3000 }],
      [{ port: 3000 }],
      [{ port: 3000 }, { port: 5173, pid: 1 }],
      [],
    ];
    let calls = 0;
    const seen: RunnerNotification[] = [];
    const stop = watchPorts((n) => seen.push(n), {
      intervalMs: 10,
      list: async () => lists[Math.min(calls++, lists.length - 1)] ?? [],
    });
    const deadline = Date.now() + 2_000;
    while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(10);
    stop();
    expect(seen).toEqual([
      { method: "ports.changed", params: { ports: [{ port: 3000 }] } },
      { method: "ports.changed", params: { ports: [{ port: 3000 }, { port: 5173, pid: 1 }] } },
      { method: "ports.changed", params: { ports: [] } },
    ]);
    const after = calls;
    await Bun.sleep(40);
    expect(calls).toBe(after);
  });
});
