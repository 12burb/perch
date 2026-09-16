/**
 * Traces (spec §8 "OpenTelemetry SDK, OTLP export off by default"; §5.7 "OTel traces and cost per
 * task"; task 3.22).
 *
 * One trace per session round and per bot run, with a span for every model call, tool call and
 * runner RPC underneath it. That is the shape the question wants: "the agent took four minutes" is
 * never the useful answer, and "three of those were one `fs.search` on a repository nobody had
 * indexed" is.
 *
 * Off unless `PERCH_OTLP_ENDPOINT` is set. With no endpoint there is no SDK, no exporter and no
 * background flush — `span()` still runs the work, because a Perch with tracing off must behave
 * exactly like a Perch with tracing on minus the spans (ADR-0141).
 */
import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Logger } from "pino";

/** The one tracer everything here uses; named for the service rather than the file. */
export const tracer = trace.getTracer("perch");

export type Tracing = { shutdown: () => Promise<void> };

/**
 * Start exporting, when there is somewhere to export to. The SDK is imported lazily so an
 * instance with tracing off never loads it — it is a large dependency to pay for nothing.
 */
export async function startTracing(
  env: { otlpEndpoint?: string | undefined; version?: string },
  log: Logger,
): Promise<Tracing | null> {
  if (!env.otlpEndpoint) return null;
  try {
    const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
    ]);
    const sdk = new NodeSDK({
      serviceName: "perch",
      traceExporter: new OTLPTraceExporter({ url: env.otlpEndpoint }),
    });
    sdk.start();
    log.info({ endpoint: env.otlpEndpoint }, "tracing on");
    return { shutdown: () => sdk.shutdown() };
  } catch (error) {
    // An instance that cannot reach its collector is an instance that still works.
    log.warn({ err: error, endpoint: env.otlpEndpoint }, "tracing did not start");
    return null;
  }
}

/**
 * Run something inside a span. The span ends whatever happens, an error is recorded on it and
 * rethrown, and with no exporter configured this is a few object allocations and the same call.
 */
export async function span<T>(
  name: string,
  attributes: Attributes,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (current) => {
    try {
      const answer = await run(current);
      current.setStatus({ code: SpanStatusCode.OK });
      return answer;
    } catch (error) {
      current.recordException(error instanceof Error ? error : new Error(String(error)));
      current.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      current.end();
    }
  });
}

/** Attributes that are always safe to attach: ids and small facts, never content (§9.1's log rule). */
export function ids(input: {
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  sessionId?: string | undefined;
  userId?: string | undefined;
  botId?: string | undefined;
  workItemId?: string | undefined;
}): Attributes {
  const out: Attributes = {};
  if (input.workspaceId) out["perch.workspace_id"] = input.workspaceId;
  if (input.projectId) out["perch.project_id"] = input.projectId;
  if (input.sessionId) out["perch.session_id"] = input.sessionId;
  if (input.userId) out["perch.user_id"] = input.userId;
  if (input.botId) out["perch.bot_id"] = input.botId;
  if (input.workItemId) out["perch.work_item_id"] = input.workItemId;
  return out;
}
