import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childLaptopStarter, serveArgs } from "../src/laptop-child.ts";
import { fileSink, LOG_FILE, ROTATE_AT, stdStreamsAttached, streamSink } from "../src/sink.ts";

const dir = mkdtempSync(join(tmpdir(), "perch-desktop-child-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A stand-in for `perch-desktop --serve`: logs a line, prints the ready line, waits for stdin to close.
const FAKE_SERVER = `
const args = process.argv.slice(2);
console.log(JSON.stringify({ level: 30, msg: "booting", args }));
console.error("from stderr");
console.log(JSON.stringify({ serve: "ready", url: "http://localhost:47160", dataDir: "/data" }));
process.stdin.on("end", () => { console.log("released"); process.exit(0); });
process.stdin.resume();
`;

describe("the server child process", () => {
  test("--serve arguments carry the port, the public URL, the log level, and the data dir", () => {
    expect(
      serveArgs({
        port: 47160,
        publicUrl: "http://localhost:47160",
        logLevel: "warn",
        dataDir: "/d",
      }),
    ).toEqual([
      "--serve",
      "--port",
      "47160",
      "--public-url",
      "http://localhost:47160",
      "--log-level",
      "warn",
      "--data-dir",
      "/d",
    ]);
    expect(serveArgs({ port: 0, publicUrl: "http://localhost:0", logLevel: "info" })).not.toContain(
      "--data-dir",
    );
  });

  test("resolves on the ready line, forwards every line of both streams, stops when told", async () => {
    const script = join(dir, "server.ts");
    writeFileSync(script, FAKE_SERVER);
    const forwarded: string[] = [];
    const start = childLaptopStarter(
      (stream, line) => forwarded.push(`${stream}: ${line}`),
      () => [process.execPath, script],
    );
    const laptop = await start({
      port: 47160,
      publicUrl: "http://localhost:47160",
      logLevel: "warn",
    });
    expect(laptop.url).toBe("http://localhost:47160");
    expect(laptop.dataDir).toBe("/data");
    await laptop.stop();
    await laptop.stop(); // idempotent
    expect(forwarded.some((line) => line.includes('"msg":"booting"'))).toBe(true);
    expect(forwarded.some((line) => line.includes('"--port","47160"'))).toBe(true);
    expect(forwarded).toContain("err: from stderr");
    expect(forwarded).toContain("out: released");
  });

  test("a child that exits before the ready line rejects with its exit code", async () => {
    const script = join(dir, "dies.ts");
    writeFileSync(script, "console.log('no server today'); process.exit(3);");
    const start = childLaptopStarter(
      () => {},
      () => [process.execPath, script],
    );
    await expect(
      start({ port: 47160, publicUrl: "http://localhost:47160", logLevel: "warn" }),
    ).rejects.toThrow("exited with 3 before it was ready");
  });
});

describe("the sink", () => {
  test("a file sink writes timestamped lines under <dataDir>/desktop and rotates once past the limit", () => {
    const dataDir = join(dir, "data");
    const sink = fileSink(dataDir);
    expect(sink.file).toBe(join(dataDir, LOG_FILE));
    sink.out('{"smoke":"ok"}');
    sink.err("perch-desktop: something");
    const text = readFileSync(join(dataDir, LOG_FILE), "utf8");
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[^ ]+ out \{"smoke":"ok"\}\n/);
    expect(text).toContain(" err perch-desktop: something\n");

    writeFileSync(join(dataDir, LOG_FILE), "x".repeat(ROTATE_AT + 1));
    const rotated = fileSink(dataDir);
    rotated.out("fresh");
    expect(statSync(`${join(dataDir, LOG_FILE)}.1`).size).toBe(ROTATE_AT + 1);
    expect(readFileSync(join(dataDir, LOG_FILE), "utf8")).toContain(" out fresh\n");
  });

  test("the stream sink has no file; outside Windows the streams always count as attached", async () => {
    expect(streamSink().file).toBeNull();
    if (process.platform !== "win32") expect(await stdStreamsAttached()).toBe(true);
    else expect(typeof (await stdStreamsAttached())).toBe("boolean");
  });
});
