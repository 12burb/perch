import { describe, expect, test } from "bun:test";
import {
  authorizationServer,
  chooseClient,
  protectedResource,
  registerClient,
  resourceMetadataFromChallenge,
  resourceMetadataUrls,
  sameResource,
  serverMetadataUrls,
} from "../src/discovery.ts";
import { deleteGitHubGrant, refreshTokens, revokeToken } from "../src/oauth.ts";

/**
 * Task 2.14 (spec §3.5): finding the authorization server in front of an MCP server, its endpoints,
 * and a client id — by the lanes in the order the spec names them.
 */

/** A stand-in provider: whatever the map says, and 404 for everything else. */
function server(routes: Record<string, unknown>, options: { challenge?: string } = {}) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST" && routes[`POST ${url}`]) {
      return Response.json(routes[`POST ${url}`]);
    }
    if (options.challenge && url === options.challenge) {
      return new Response("no", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${options.challenge}/meta"`,
        },
      });
    }
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return Response.json(body);
  }) as typeof fetch;
  return { fetcher, asked };
}

describe("MCP OAuth discovery", () => {
  test("RFC 9728: the document sits under the resource's path, then at the origin", () => {
    expect(resourceMetadataUrls("https://mcp.example.test/mcp")).toEqual([
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.test/.well-known/oauth-protected-resource",
    ]);
    expect(resourceMetadataUrls("https://mcp.example.test/")).toEqual([
      "https://mcp.example.test/.well-known/oauth-protected-resource",
    ]);
  });

  test("a 401 can say where its metadata is", () => {
    expect(
      resourceMetadataFromChallenge('Bearer realm="x", resource_metadata="https://a.test/meta"'),
    ).toBe("https://a.test/meta");
    expect(resourceMetadataFromChallenge("Bearer")).toBeNull();
    expect(resourceMetadataFromChallenge(null)).toBeNull();
  });

  test("the resource names its authorization server", async () => {
    const { fetcher } = server({
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp": {
        resource: "https://mcp.example.test/mcp",
        authorization_servers: ["https://auth.example.test"],
      },
    });
    const found = await protectedResource("https://mcp.example.test/mcp", fetcher);
    expect(found?.authorization_servers).toEqual(["https://auth.example.test"]);
  });

  test("a server with no document at all answers nothing, rather than throwing", async () => {
    const { fetcher } = server({});
    expect(await protectedResource("https://mcp.example.test/mcp", fetcher)).toBeNull();
  });

  test("RFC 8414 first, then OpenID Connect discovery", () => {
    expect(serverMetadataUrls("https://auth.example.test/tenant")).toEqual([
      "https://auth.example.test/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.test/tenant/.well-known/oauth-authorization-server",
      "https://auth.example.test/tenant/.well-known/openid-configuration",
      "https://auth.example.test/.well-known/openid-configuration/tenant",
    ]);
  });

  test("the authorization server's endpoints", async () => {
    const { fetcher, asked } = server({
      "https://auth.example.test/.well-known/openid-configuration": {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        registration_endpoint: "https://auth.example.test/register",
      },
    });
    const meta = await authorizationServer("https://auth.example.test", fetcher);
    expect(meta?.token_endpoint).toBe("https://auth.example.test/token");
    // RFC 8414's path was tried before OIDC's, which is the order the spec names.
    expect(asked[0]).toContain("/.well-known/oauth-authorization-server");
  });

  test("the lanes, in order: a registered app, then CIMD, then registration on the spot", async () => {
    const base = {
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
    };
    const registration = { client_name: "Perch", redirect_uris: ["https://perch.test/cb"] };
    const cimdUrl = "https://perch.test/.well-known/oauth-client-metadata.json";

    // An app somebody registered here wins, whatever else the server offers.
    const first = await chooseClient({
      server: { ...base, registration_endpoint: "https://auth.example.test/register" },
      preRegistered: { clientId: "app-1", clientSecret: "shh" },
      cimdUrl,
      registration,
    });
    expect(first).toMatchObject({ lane: "pre_registered", clientId: "app-1", clientSecret: "shh" });

    // Then this instance's own metadata document, when the server takes one.
    const second = await chooseClient({
      server: { ...base, client_id_metadata_document_supported: true },
      cimdUrl,
      registration,
    });
    expect(second).toEqual({ lane: "cimd", clientId: cimdUrl });

    // Then a client registered on the spot — the lane Supabase's MCP server uses.
    const { fetcher, asked } = server({
      "POST https://auth.example.test/register": { client_id: "dcr-1", client_secret: "dcr-shh" },
    });
    const third = await chooseClient({
      server: { ...base, registration_endpoint: "https://auth.example.test/register" },
      cimdUrl,
      registration,
      fetcher,
    });
    expect(third).toMatchObject({ lane: "dcr", clientId: "dcr-1", clientSecret: "dcr-shh" });
    expect(asked).toEqual(["POST https://auth.example.test/register"]);

    // And a server that offers none of the three says so rather than guessing.
    await expect(chooseClient({ server: base, cimdUrl, registration })).rejects.toThrow(
      /register an app or paste a token/,
    );
  });

  test("a registration the server refuses is an error with its status", async () => {
    const fetcher = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(
      registerClient("https://auth.example.test/register", {}, fetcher),
    ).rejects.toMatchObject({ status: 403 });
  });

  test("a protected-resource document for some other resource is not used (RFC 9728 §3.3)", async () => {
    const { fetcher } = server({
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp": {
        resource: "https://elsewhere.example.test/mcp",
        authorization_servers: ["https://auth.example.test"],
      },
    });
    expect(await protectedResource("https://mcp.example.test/mcp", fetcher)).toBeNull();
    // The same server in another spelling is still the same server.
    expect(sameResource("https://MCP.example.test:443/mcp/", "https://mcp.example.test/mcp")).toBe(
      true,
    );
    expect(sameResource("https://mcp.example.test/other", "https://mcp.example.test/mcp")).toBe(
      false,
    );
  });

  test("a document a 401 points at is held to the same rule", async () => {
    const { fetcher } = server(
      {
        "https://mcp.example.test/mcp/meta": {
          resource: "https://elsewhere.example.test/mcp",
          authorization_servers: ["https://auth.example.test"],
        },
      },
      { challenge: "https://mcp.example.test/mcp" },
    );
    expect(await protectedResource("https://mcp.example.test/mcp", fetcher)).toBeNull();
  });

  test("a server document for another issuer, or with plain-http endpoints, is not used", async () => {
    const endpoints = {
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
    };
    const other = server({
      "https://auth.example.test/.well-known/oauth-authorization-server": {
        issuer: "https://impostor.example.test",
        ...endpoints,
      },
    });
    expect(await authorizationServer("https://auth.example.test", other.fetcher)).toBeNull();
    const plain = server({
      "https://auth.example.test/.well-known/oauth-authorization-server": {
        issuer: "https://auth.example.test",
        ...endpoints,
        token_endpoint: "http://auth.example.test/token",
      },
    });
    expect(await authorizationServer("https://auth.example.test", plain.fetcher)).toBeNull();
    // On this machine, plain http is what a local server has.
    const local = server({
      "http://127.0.0.1:9999/.well-known/oauth-authorization-server": {
        issuer: "http://127.0.0.1:9999",
        authorization_endpoint: "http://127.0.0.1:9999/authorize",
        token_endpoint: "http://127.0.0.1:9999/token",
        revocation_endpoint: "http://127.0.0.1:9999/revoke",
      },
    });
    const found = await authorizationServer("http://127.0.0.1:9999", local.fetcher);
    expect(found?.revocation_endpoint).toBe("http://127.0.0.1:9999/revoke");
  });
});

describe("refresh and revocation (ADR-0173)", () => {
  type Sent = { url: string; method: string; headers: Headers; body: string };
  function recorder(status = 200, answer: unknown = {}) {
    const sent: Sent[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      sent.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      });
      return Response.json(answer, { status });
    };
    return { sent, fetcher };
  }

  test("a refresh names the resource it is for (RFC 8707)", async () => {
    const { sent, fetcher } = recorder(200, { access_token: "new", expires_in: 60 });
    const tokens = await refreshTokens({
      tokenUrl: "https://auth.example.test/token",
      clientId: "dcr-1",
      clientSecret: "shh",
      refreshToken: "r-1",
      resource: "https://mcp.example.test/mcp",
      fetcher,
    });
    expect(tokens.accessToken).toBe("new");
    const form = new URLSearchParams(sent[0]?.body);
    expect(form.get("resource")).toBe("https://mcp.example.test/mcp");
    expect(sent[0]?.headers.get("authorization")).toBe(`Basic ${btoa("dcr-1:shh")}`);
  });

  test("RFC 7009: the token goes back with its type and the client that holds it", async () => {
    const { sent, fetcher } = recorder(200);
    await revokeToken({
      endpoint: "https://auth.example.test/revoke",
      token: "r-1",
      tokenTypeHint: "refresh_token",
      clientId: "dcr-1",
      fetcher,
    });
    const form = new URLSearchParams(sent[0]?.body);
    expect(sent[0]?.method).toBe("POST");
    expect(form.get("token")).toBe("r-1");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("dcr-1");
    expect(sent[0]?.headers.get("authorization")).toBeNull();
    const refused = recorder(503);
    await expect(
      revokeToken({
        endpoint: "https://auth.example.test/revoke",
        token: "r-1",
        clientId: "dcr-1",
        fetcher: refused.fetcher,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test("GitHub's grant deletion is the app's call, naming a token of the grant", async () => {
    const { sent, fetcher } = recorder(204);
    await deleteGitHubGrant({
      apiBase: "https://api.github.test/",
      clientId: "app-1",
      clientSecret: "app-secret",
      accessToken: "gho_1",
      fetcher: async (url, init) => {
        await fetcher(url, init);
        return new Response(null, { status: 204 });
      },
    });
    expect(sent[0]).toMatchObject({
      url: "https://api.github.test/applications/app-1/grant",
      method: "DELETE",
    });
    expect(sent[0]?.headers.get("authorization")).toBe(`Basic ${btoa("app-1:app-secret")}`);
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({ access_token: "gho_1" });
  });
});
