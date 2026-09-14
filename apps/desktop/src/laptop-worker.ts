/**
 * Laptop mode started on a worker thread and driven from here (ADR-0063, Windows). The handle looks
 * like the in-process one, so desktop.ts does not care where the server runs.
 */
import type { LaptopOptions } from "@perch/cli/laptop";
import type { LaptopHandle } from "./desktop.ts";
import type { ServerWorkerInbound, ServerWorkerOutbound } from "./server-worker.ts";

export function startLaptopInWorker(options: LaptopOptions): Promise<LaptopHandle> {
  // "./server-worker.js": the name the compiled binary embeds; in source mode Bun maps it to the .ts.
  const worker = new Worker(new URL("./server-worker.js", import.meta.url));
  const send = (message: ServerWorkerInbound) => worker.postMessage(message);
  let stopping: Promise<void> | null = null;
  return new Promise((resolve, reject) => {
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`server worker: ${event.message}`));
    };
    worker.onmessage = (event: MessageEvent<ServerWorkerOutbound>) => {
      const message = event.data;
      if (message.event === "started") {
        resolve({
          url: message.url,
          dataDir: message.dataDir,
          stop() {
            stopping ??= new Promise<void>((done) => {
              worker.onmessage = () => {
                worker.terminate();
                done();
              };
              send({ cmd: "stop" });
            });
            return stopping;
          },
        });
      } else if (message.event === "failed") {
        worker.terminate();
        reject(new Error(message.message));
      }
    };
    send({ cmd: "start", options });
  });
}
