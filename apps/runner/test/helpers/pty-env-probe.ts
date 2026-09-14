/**
 * Runs in a child process whose real environment carries PERCH_RUNNER_TOKEN (pty.test.ts): opens a
 * shell through PtyManager and prints what the shell sees, so the test checks the invariant against
 * the PTY layer's actual environment handling rather than against process.env alone.
 */
import { PtyManager } from "../../src/pty.ts";
import { createStreamPair } from "../../src/streams.ts";

const [root, user] = process.argv.slice(2);
if (!root || !user) {
  console.error("usage: pty-env-probe <root> <user>");
  process.exit(2);
}
const win = process.platform === "win32";
const manager = new PtyManager({ root, tmux: false, graceMs: 60_000 });
const opened = await manager.open({
  workspace_id: "0190f2d0-0000-7000-8000-000000000001",
  user_id: user,
  cap: "probe",
  cols: 80,
  rows: 24,
  cwd: ".",
  user,
});
const pair = createStreamPair();
manager.attachToken(opened.stream_token, pair.b);
let output = "";
const done = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no answer in:\n${output}`)), 20_000);
  pair.a.onMessage((data) => {
    output += data;
    if (output.includes("] done")) {
      clearTimeout(timer);
      resolve();
    }
  });
});
// The marker is spelled so that only the shell's answer carries it, not the echoed input.
pair.a.send(
  win
    ? "echo tok=[%PERCH_RUNNER_TOKEN%] user=[%PERCH_USER%] d^one\r"
    : 'echo tok=[$PERCH_RUNNER_TOKEN] user=[$PERCH_USER] d""one\r',
);
try {
  await done;
  const line = output.split("\n").find((l) => /tok=\[.*] done/.test(l)) ?? "";
  console.log(`PROBE ${line.trim()}`);
} finally {
  manager.closeAll();
}
process.exit(0);
