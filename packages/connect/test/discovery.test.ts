import { describe, expect, test } from "bun:test";
import {
  authorizationServer,
  chooseClient,
  protectedResource,
  registerClient,
  resourceMetadataFromChallenge,
  resourceMetadataUrls,
  serverMetadataUrls,
} from "../src/discovery.ts";

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
});
