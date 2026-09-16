/**
 * The spans the api made, in memory (task 3.22).
 *
 * Registering a tracer provider is global and `bun test` runs every file in one process, so this
 * is deliberately narrow: a file asks for the exporter in `beforeAll` and gives it back in
 * `afterAll`, and the 147 files that know nothing about tracing run against the no-op tracer they
 * always did. A fixture that quietly turns telemetry on for a whole suite is a fixture that
 * changes what the suite is testing.
 */
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

/** Start collecting. Idempotent: two files in one process share the one exporter. */
export function captureSpans(): InMemorySpanExporter {
  trace.disable();
  trace.setGlobalTracerProvider(provider);
  return exporter;
}

/** Stop, leaving the process as it was found. */
export function releaseSpans(): void {
  trace.disable();
}
