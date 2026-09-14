/** How to run this very program again: the compiled binary, or `bun <entry>` in source mode. */
export function selfCommand(): string[] {
  // Bun's embedded file system: /$bunfs/root/... on POSIX, B:\~BUN\root\... on Windows.
  const compiled = /\/\$bunfs\/|\\~BUN\\/.test(import.meta.path);
  return compiled ? [process.execPath] : [process.execPath, process.argv[1] ?? ""];
}
