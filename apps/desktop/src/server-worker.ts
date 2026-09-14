/**
 * Laptop mode on a worker thread (ADR-0063, Windows): the main thread owns the native run loop, so the
 * server lives here. Messages in: start, stop. Messages out: started, failed, stopped.
 */
import { type LaptopOptions, startLaptop } from "@perch/cli/laptop";

export type ServerWorkerInbound = { cmd: "start"; options: LaptopOptions } | { cmd: "stop" };
export type ServerWorkerOutbound =
  | { event: "started"; url: string; dataDir: string }
  | { event: "failed"; message: string }
  | { event: "stopped" };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ServerWorkerInbound>) => void) | null;
  postMessage(message: ServerWorkerOutbound): void;
};

let laptop: Awaited<ReturnType<typeof startLaptop>> | null = null;

scope.onmessage = async (event) => {
  const message = event.data;
  if (message.cmd === "start") {
    try {
      laptop = await startLaptop(message.options);
      scope.postMessage({ event: "started", url: laptop.url, dataDir: laptop.dataDir });
    } catch (error) {
      scope.postMessage({
        event: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (message.cmd === "stop") {
    await laptop?.stop();
    scope.postMessage({ event: "stopped" });
  }
};
