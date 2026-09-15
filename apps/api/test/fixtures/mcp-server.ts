/**
 * A stand-in MCP server with its own authorization server (task 2.14): RFC 9728 protected-resource
 * metadata, RFC 8414 server metadata, RFC 7591 registration, an authorization endpoint that
 * redirects straight back, and a token endpoint.
 *
 * Nothing here mocks Perch's code. Discovery, registration, the PKCE round-trip and the code
 * exchange all really happen, against a server that records what it saw — so a test can prove
 * which lane Perch took, that the verifier matched the challenge, and that the resource indicator
 * named the MCP server the token is for.
 */
import { createHash } from "node:crypto";

export type StandInMcp = {
  /** The MCP endpoint itself: the resource a token is minted for. */
  mcpUrl: string;
  /** The authorization server's issuer, which its metadata is published under. */
  issuer: string;
  /** Every request it saw, in order, so a test can assert the discovery sequence. */
  seen: { method: string; path: string }[];
  /** The client ids it registered (RFC 7591), in the order it issued them. */
  registered: { clientId: string; metadata: Record<string, unknown> }[];
  /** What the last authorization request carried, to prove PKCE and RFC 8707 went out. */
  lastAuthorization: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    method: string;
    scope: string;
    resource: string;
  } | null;
  /** What the last token exchange carried. */
  lastExchange: Record<string, string> | null;
  /** The access token it issues, to prove the connection kept the one it was given. */
  accessToken: string;
  stop(): void;
};

export type StandInMcpOptions = {
  /**
   * Which lane the server offers. `dcr` registers clients on the spot (RFC 7591), `cimd` takes a
   * client metadata document URL as the client id, `none` offers neither — the case that leaves
   * the token paste lane.
   */
  lane?: "dcr" | "cimd" | "none";
  /** Serve the protected-resource document, or make Perch read the MCP server's own 401. */
  publishResourceMetadata?: boolean;
  port?: number;
};

const OK = { "content-type": "application/json", "cache-control": "no-store" } as const;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Starts the server; the caller stops it. Port 0 means "whatever is free". */
export function startStandInMcp(options: StandInMcpOptions = {}): StandInMcp {
  const lane = options.lane ?? "dcr";
  const publish = options.publishResourceMetadata ?? true;
  const seen: StandInMcp["seen"] = [];
  const registered: StandInMcp["registered"] = [];
  const codes = new Map<string, { challenge: string; clientId: string; resource: string }>();
  const state: {
    lastAuthorization: StandInMcp["lastAuthorization"];
    lastExchange: StandInMcp["lastExchange"];
  } = { lastAuthorization: null, lastExchange: null };
  const accessToken = `mcp-access-${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
  // Filled in the moment the port is known, which is before anything can be asked for.
  let origin = "";

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      seen.push({ method: request.method, path: url.pathname });

      // RFC 9728 §3.1: where the document lives, with the resource's path appended.
      if (publish && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json(
          {
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: ["mcp:read", "mcp:write"],
          },
          { headers: OK },
        );
      }

      // RFC 8414: the authorization server's endpoints.
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json(
          {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            ...(lane === "dcr" ? { registration_endpoint: `${origin}/register` } : {}),
            ...(lane === "cimd" ? { client_id_metadata_document_supported: true } : {}),
            scopes_supported: ["mcp:read", "mcp:write"],
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["authorization_code", "refresh_token"],
          },
          { headers: OK },
        );
      }

      // RFC 7591: a client registered on the spot. A public client, so PKCE is the whole proof.
      if (url.pathname === "/register" && request.method === "POST") {
        if (lane !== "dcr") return new Response("not found", { status: 404 });
        const metadata = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const clientId = `dcr-client-${registered.length + 1}`;
        registered.push({ clientId, metadata });
        return Response.json(
          { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) },
          { status: 201, headers: OK },
        );
      }

      // The authorization endpoint: no login page, because a browser test wants the round-trip,
      // not a form somebody else wrote. It records what came in and redirects back with a code.
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const redirectUri = q.get("redirect_uri") ?? "";
        state.lastAuthorization = {
          clientId: q.get("client_id") ?? "",
          redirectUri,
          challenge: q.get("code_challenge") ?? "",
          method: q.get("code_challenge_method") ?? "",
          scope: q.get("scope") ?? "",
          resource: q.get("resource") ?? "",
        };
        const code = `code-${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
        codes.set(code, {
          challenge: q.get("code_challenge") ?? "",
          clientId: q.get("client_id") ?? "",
          resource: q.get("resource") ?? "",
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        const returned = q.get("state");
        if (returned) back.searchParams.set("state", returned);
        return Response.redirect(back.toString(), 302);
      }

      // The token endpoint: the verifier is checked against the challenge, which is what makes the
      // round-trip worth testing at all.
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        state.lastExchange = Object.fromEntries(form.entries());
        const code = form.get("code") ?? "";
        const issued = codes.get(code);
        codes.delete(code);
        if (!issued) {
          return Response.json({ error: "invalid_grant" }, { status: 400, headers: OK });
        }
        const verifier = form.get("code_verifier") ?? "";
        const digest = base64url(new Uint8Array(createHash("sha256").update(verifier).digest()));
        if (digest !== issued.challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400, headers: OK });
        }
        return Response.json(
          {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "mcp-refresh",
            scope: "mcp:read mcp:write",
          },
          { headers: OK },
        );
      }

      // The MCP endpoint itself. Unauthenticated, it says where to get a token (RFC 9728 §5.1),
      // which is the fallback for a server that publishes no document.
      if (url.pathname === "/mcp") {
        const bearer = request.headers.get("authorization");
        if (bearer === `Bearer ${accessToken}`) {
          return Response.json({ ok: true }, { headers: OK });
        }
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  origin = `http://127.0.0.1:${server.port}`;

  return {
    mcpUrl: `${origin}/mcp`,
    issuer: origin,
    seen,
    registered,
    get lastAuthorization() {
      return state.lastAuthorization;
    },
    get lastExchange() {
      return state.lastExchange;
    },
    accessToken,
    stop: () => server.stop(true),
  };
}
