/**
 * A stand-in dev server for the preview tests (task 4.8).
 *
 * The tests need three behaviours — stay up, fail with something on stderr, and hold a child that
 * outlives a kill of the shell — and they need them on Windows too, where the shell is `cmd.exe`
 * and `a && b`, `a; b`, `a &` and `wait` do not mean what they mean in `sh`. A program the shell
 * only has to launch works the same everywhere.
 *
 *   bun dev-server.ts --stay        print a line, then stay up
 *   bun dev-server.ts --fail        complain on stderr and exit 7
 *   bun dev-server.ts --child       start a child that outlives a kill of this process, then wait
 */
const mode = process.argv[2] ?? "--stay";

if (mode === "--fail") {
  process.stderr.write("port 3000 is taken\n");
  process.exit(7);
}

if (mode === "--child") {
  const child = Bun.spawn([process.execPath, import.meta.path, "--stay"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  console.log(`child ${child.pid}`);
  await child.exited;
  process.exit(0);
}

console.log("listening on hello.txt");
// Long enough for any of these tests; they stop it themselves.
await Bun.sleep(120_000);
