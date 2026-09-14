/**
 * The Windows smoke helper (ADR-0063): while the main thread sits in the native run loop, this thread
 * waits and then posts WM_CLOSE to the window, which ends the loop the way a user would.
 */
export type CloserInbound = { hwnd: string; afterMs: number };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CloserInbound>) => void) | null;
  postMessage(message: { posted: number }): void;
};

scope.onmessage = (event) => {
  const { hwnd, afterMs } = event.data;
  setTimeout(async () => {
    if (process.platform !== "win32") return;
    const { dlopen, FFIType } = await import("bun:ffi");
    const user32 = dlopen("user32.dll", {
      PostMessageW: {
        args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64],
        returns: FFIType.i32,
      },
    });
    const WM_CLOSE = 0x0010;
    const posted = user32.symbols.PostMessageW(BigInt(hwnd), WM_CLOSE, 0n, 0n);
    scope.postMessage({ posted });
  }, afterMs);
};
