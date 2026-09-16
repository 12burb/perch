/**
 * The spans the api made, in memory (task 3.22).
 *
 * Registering a tracer provider is global and takes once per process — `bun test` runs every file
 * in one — so this hands the same exporter to whichever file asks first and to every one after it.
 * A second registration would quietly do nothing and the second file's assertions would be about
 * an exporter nobody exports to.
 */
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

let exporter: InMemorySpanExporter | null = null;

export function captureSpans(): InMemorySpanExporter {
  if (exporter) return exporter;
  const made = new InMemorySpanExporter();
  // The same context manager the SDK installs in a running instance, so a span opened three
  // layers below its round is a child here for the same reason it is one in production.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(made)] }),
  );
  exporter = made;
  return made;
}
