/**
 * `/v1` — the OpenAI-compatible gateway (spec §3.4, §7.4; task 4.1).
 *
 * These are not `/api` routes and they are not in the OpenAPI document: their contract is
 * somebody else's, and a client holding an OpenAI SDK should not have to learn Perch's error shape
 * to use a Perch. So they are plain Hono handlers with OpenAI's request bodies, OpenAI's answers,
 * and OpenAI's errors — plus the `Perch-…` headers §7.4 asks for, which a client that does not
 * know about them ignores.
 *
 * Authentication is `Authorization: Bearer pk_…` and nothing else. A session cookie is not enough:
 * a browser tab must not be able to spend a workspace's credit because somebody opened a page.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  type ChatRequest,
  chatRequestSchema,
  chunkBody,
  complete,
  completionBody,
  completionId,
  embeddingsBody,
  embeddingsRequestSchema,
  errorBody,
  modelBody,
  sse,
  streamCompletion,
  toMessages,
  toSettings,
} from "@perch/gateway";
import type { Context } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import type { Chosen, ResolvedKey } from "../services/model-gateway.ts";

/** The body sizes a gateway accepts: a prompt, not an upload. */
const MAX_BODY = 1_000_000;

function bearer(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}

function refuse(
  c: Context<AppEnv>,
  status: 400 | 401 | 402 | 404 | 429 | 500 | 502,
  message: string,
  type: string,
  code?: string,
) {
  return c.json(errorBody({ message, type, ...(code ? { code } : {}) }), status);
}

/** Who a key speaks as when a credential asks. A key that is nobody gets nobody's credentials. */
function speakerOf(key: ResolvedKey): string {
  return key.subjectType === "user" && key.subjectId ? key.subjectId : "";
}

export function registerV1(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  /** The key behind this request, or an answer that says so in OpenAI's words. */
  const keyed = async (c: Context<AppEnv>): Promise<ResolvedKey | Response> => {
    const token = bearer(c);
    if (!token) {
      return refuse(
        c,
        401,
        "a Perch virtual key is required: Authorization: Bearer pk_…",
        "invalid_request_error",
        "missing_api_key",
      );
    }
    const key = await deps.modelGateway.resolve(token);
    if (!key) {
      return refuse(
        c,
        401,
        "that key is not one this Perch knows",
        "invalid_request_error",
        "invalid_api_key",
      );
    }
    return key;
  };

  /**
   * Nothing is called until there is room to pay for it (spec §7.4's `402`): the key's own budget,
   * and the workspace's and the subject's ceilings above it (task 4.2). The tightest wins.
   */
  const afford = async (
    c: Context<AppEnv>,
    key: ResolvedKey,
  ): Promise<number | null | Response> => {
    const remaining = await deps.modelGateway.remaining(key.row);
    if (remaining !== null && remaining <= 0) {
      c.header("Perch-Budget-Remaining", "0");
      return refuse(
        c,
        402,
        "this key has spent its budget",
        "insufficient_quota",
        "budget_exceeded",
      );
    }
    const subjects =
      key.subjectType === "user" || key.subjectType === "bot"
        ? ([{ type: "workspace" as const }, { type: key.subjectType, id: key.subjectId }] as const)
        : ([{ type: "workspace" as const }] as const);
    const verdict = await deps.budgets.check(key.workspaceId, subjects, {
      actor: { type: "system" },
      meta: {},
    });
    if (!verdict.ok) {
      c.header("Perch-Budget-Remaining", "0");
      return refuse(c, 402, verdict.reason, "insufficient_quota", "budget_exceeded");
    }
    if (verdict.remainingUsd === null) return remaining;
    return remaining === null ? verdict.remainingUsd : Math.min(remaining, verdict.remainingUsd);
  };

  app.get("/v1/models", async (c: Context<AppEnv>) => {
    const key = await keyed(c);
    if (key instanceof Response) return key;
    const profiles = await deps.modelGateway.models(key);
    return c.json({
      object: "list",
      data: profiles.map((profile) =>
        modelBody({
          id: profile.name,
          ownedBy: profile.provider,
          created: Math.floor(profile.createdAt.getTime() / 1000),
        }),
      ),
    });
  });

  app.post("/v1/chat/completions", async (c: Context<AppEnv>) => {
    const key = await keyed(c);
    if (key instanceof Response) return key;

    const raw = await c.req.text();
    if (raw.length > MAX_BODY) {
      return refuse(c, 400, "that request is too large", "invalid_request_error");
    }
    let body: ChatRequest;
    try {
      body = chatRequestSchema.parse(JSON.parse(raw));
    } catch (error) {
      return refuse(
        c,
        400,
        error instanceof Error ? error.message : "that is not a chat completion request",
        "invalid_request_error",
      );
    }

    const remaining = await afford(c, key);
    if (remaining instanceof Response) return remaining;

    let first: Chosen;
    try {
      first = await deps.modelGateway.choose(key, body.model, speakerOf(key));
    } catch (error) {
      return refuse(
        c,
        404,
        error instanceof Error ? error.message : `${body.model} is not a model this key may use`,
        "invalid_request_error",
        "model_not_found",
      );
    }
    const chain = await deps.modelGateway.chain(key, first, speakerOf(key));
    const { system, messages } = toMessages(body);
    const settings = toSettings(body);
    const id = completionId();

    if (body.stream) {
      // A streamed answer cannot carry its cost in a header — the headers are long gone by the
      // time the last token is. The usage rides in the final chunk instead, the way OpenAI's own
      // `stream_options.include_usage` does, and the ledger gets its row either way.
      const chosen = chain[0];
      if (!chosen) return refuse(c, 404, "no model to call", "invalid_request_error");
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Perch-Provider", chosen.provider);
      if (remaining !== null) c.header("Perch-Budget-Remaining", String(remaining));
      const stream = streamCompletion({
        model: chosen.model,
        ...(system ? { system } : {}),
        messages,
        settings,
      });
      return c.body(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
            send(sse(chunkBody({ id, model: body.model, role: "assistant", delta: "" })));
            try {
              for await (const delta of stream.textStream) {
                send(sse(chunkBody({ id, model: body.model, delta })));
              }
              const usage = await stream.usage();
              const input = usage.input;
              const output = usage.output;
              const costUsd = deps.modelGateway.cost(chosen.modelId, { input, output });
              send(
                sse(
                  chunkBody({
                    id,
                    model: body.model,
                    finish: "stop",
                    usage: { input, output },
                  }),
                ),
              );
              send(sse("[DONE]"));
              await deps.modelGateway.record({
                workspaceId: key.workspaceId,
                actorType: key.subjectType,
                actorId: key.subjectId,
                virtualKeyId: key.row.id,
                provider: chosen.provider,
                modelId: chosen.modelId,
                inputTokens: input,
                outputTokens: output,
                costUsd,
                by: { actor: { type: "system" }, meta: {} },
              });
            } catch (error) {
              deps.log.warn({ err: error }, "a streamed completion failed");
              send(
                sse(
                  errorBody({
                    message: error instanceof Error ? error.message : "the provider failed",
                    type: "api_error",
                  }),
                ),
              );
              send(sse("[DONE]"));
            } finally {
              controller.close();
            }
          },
        }),
      );
    }

    // Not streamed: try the chain in order, and answer with whichever provider actually spoke.
    let failure: unknown = null;
    for (const chosen of chain) {
      try {
        const answer = await complete({
          model: chosen.model,
          ...(system ? { system } : {}),
          messages,
          settings,
        });
        const input = answer.usage.input;
        const output = answer.usage.output;
        const cached = answer.usage.cached;
        const costUsd = deps.modelGateway.cost(chosen.modelId, { input, output });
        await deps.modelGateway.record({
          workspaceId: key.workspaceId,
          actorType: key.subjectType,
          actorId: key.subjectId,
          virtualKeyId: key.row.id,
          provider: chosen.provider,
          modelId: chosen.modelId,
          inputTokens: input,
          outputTokens: output,
          cachedTokens: cached,
          costUsd,
          by: { actor: { type: "system" }, meta: {} },
        });
        c.header("Perch-Provider", chosen.provider);
        c.header("Perch-Cost-Usd", costUsd.toFixed(6));
        c.header("Perch-Input-Tokens", String(input));
        c.header("Perch-Output-Tokens", String(output));
        if (remaining !== null) {
          c.header("Perch-Budget-Remaining", String(Math.round((remaining - costUsd) * 1e6) / 1e6));
        }
        return c.json(
          completionBody({
            id,
            model: body.model,
            text: answer.text,
            usage: { input, output, ...(cached ? { cached } : {}) },
            finish: answer.finishReason === "length" ? "length" : "stop",
          }),
        );
      } catch (error) {
        // The next link in the chain is what a fallback is for; the last failure is the answer.
        failure = error;
        deps.log.warn(
          { err: error, provider: chosen.provider, model: chosen.modelId },
          "a model in the chain would not answer",
        );
      }
    }
    return refuse(
      c,
      502,
      failure instanceof Error ? failure.message : "no model in the chain would answer",
      "api_error",
      "upstream_failed",
    );
  });

  app.post("/v1/embeddings", async (c: Context<AppEnv>) => {
    const key = await keyed(c);
    if (key instanceof Response) return key;
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) {
      return refuse(c, 400, "that request is too large", "invalid_request_error");
    }
    let body: ReturnType<typeof embeddingsRequestSchema.parse>;
    try {
      body = embeddingsRequestSchema.parse(JSON.parse(raw));
    } catch (error) {
      return refuse(
        c,
        400,
        error instanceof Error ? error.message : "that is not an embeddings request",
        "invalid_request_error",
      );
    }
    const remaining = await afford(c, key);
    if (remaining instanceof Response) return remaining;
    const texts = typeof body.input === "string" ? [body.input] : body.input;
    try {
      const { vectors, profile } = await deps.modelGateway.embed({
        key,
        name: body.model,
        texts,
        userId: speakerOf(key),
      });
      // Embeddings are priced per input token and nobody reports them; the ledger records the
      // call with what it knows, which is how many texts went in.
      const input = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      const costUsd = deps.modelGateway.cost(profile.modelId, { input, output: 0 });
      await deps.modelGateway.record({
        workspaceId: key.workspaceId,
        actorType: key.subjectType,
        actorId: key.subjectId,
        virtualKeyId: key.row.id,
        provider: profile.provider,
        modelId: profile.modelId,
        inputTokens: input,
        outputTokens: 0,
        costUsd,
        by: { actor: { type: "system" }, meta: {} },
      });
      c.header("Perch-Provider", profile.provider);
      c.header("Perch-Cost-Usd", costUsd.toFixed(6));
      c.header("Perch-Input-Tokens", String(input));
      return c.json(
        embeddingsBody({
          model: body.model,
          vectors,
          usage: { input },
          ...(body.encoding_format ? { format: body.encoding_format } : {}),
        }),
      );
    } catch (error) {
      deps.log.warn({ err: error }, "an embeddings call failed");
      return refuse(
        c,
        502,
        error instanceof Error ? error.message : "the provider failed",
        "api_error",
        "upstream_failed",
      );
    }
  });
}
