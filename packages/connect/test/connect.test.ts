import { describe, expect, test } from "bun:test";
import { MANIFESTS } from "@perch/connectors";
import {
  apiBaseOf,
  appJwt,
  CIMD_PATH,
  callbackUrl,
  clientMetadata,
  exchangeCode,
  GitHubAppError,
  installationToken,
  lanesOf,
  ManifestError,
  parseManifest,
  startAuthorization,
  webhookUrl,
} from "../src/index.ts";

/**
 * Task 1.16 (spec §3.5): a manifest is the only thing Perch knows about a provider, the CIMD
 * document is built from PERCH_PUBLIC_URL alone, and a GitHub App's private key becomes an
 * installation token without either ever appearing anywhere but the one request that needs it.
 */

const GITHUB = MANIFESTS.github ?? "";

describe("connector manifests", () => {
  test("the GitHub manifest that ships is valid, and its lanes come back strongest first", () => {
    const manifest = parseManifest(GITHUB);
    expect(manifest.id).toBe("github");
    expect(manifest.api_base).toBe("https://api.github.com");
    expect(lanesOf(manifest)).toEqual(["github_app", "oauth2", "token"]);
    expect(manifest.oauth?.authorize_url).toBe("https://github.com/login/oauth/authorize");
    expect(manifest.token_prefix).toContain("github_pat_");
    // A connection may point at an enterprise host; the manifest's base is only the default.
    expect(apiBaseOf(manifest)).toBe("https://api.github.com");
    expect(apiBaseOf(manifest, "https://github.example.com/api/v3/")).toBe(
      "https://github.example.com/api/v3",
    );
  });

  test("the paste lane is always there, even when a manifest forgets it", () => {
    const manifest = parseManifest(`
id: minimal
name: Minimal
auth: [oauth2]
api_base: https://api.minimal.test
oauth:
  authorize_url: https://minimal.test/authorize
  token_url: https://minimal.test/token
`);
    expect(manifest.auth).toContain("token");
    expect(lanesOf(manifest)).toEqual(["oauth2", "token"]);
  });

  test("a manifest that does not parse, or lies about its lanes, is refused with the reason", () => {
    expect(() => parseManifest("id: [")).toThrow(ManifestError);
    expect(() =>
      parseManifest("id: Nope\nname: N\nauth: [token]\napi_base: https://a.test"),
    ).toThrow(/lowercase letters/);
    expect(() => parseManifest("id: n\nname: N\nauth: [oauth2]\napi_base: https://a.test")).toThrow(
      /needs an oauth block/,
    );
    // An unknown key is a typo, not something to ignore.
    expect(() =>
      parseManifest("id: n\nname: N\nauth: [token]\napi_base: https://a.test\nnope: 1"),
    ).toThrow(ManifestError);
  });
});

describe("the client metadata document", () => {
  test("every URL comes from the public URL, and the client_id is the document itself", () => {
    const metadata = clientMetadata({
      publicUrl: "https://perch.example.com/",
      version: "0.1.0",
      providers: ["github", "vercel"],
    });
    expect(metadata.client_id).toBe(`https://perch.example.com${CIMD_PATH}`);
    expect(metadata.redirect_uris).toEqual([
      "https://perch.example.com/api/connect/callback/github",
      "https://perch.example.com/api/connect/callback/vercel",
    ]);
    // Perch is self-hosted: there is no secret a provider could have issued it.
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(callbackUrl("https://perch.example.com", "github")).toBe(
      "https://perch.example.com/api/connect/callback/github",
    );
    expect(webhookUrl("https://perch.example.com", "github", "abc")).toBe(
      "https://perch.example.com/hooks/github/abc",
    );
  });
});

/** A throwaway RSA key, generated per run: nothing here is a credential. */
async function rsaKeyPair() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const body = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, "$1\n");
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

describe("the GitHub App lane", () => {
  test("the app JWT is RS256, verifies against the key, and is dated the way GitHub demands", async () => {
    const { pem, publicKey } = await rsaKeyPair();
    const now = 1_800_000_000_000;
    const jwt = await appJwt({ appId: "12345", privateKeyPem: pem, now });
    const [header, payload, signature] = jwt.split(".");
    expect(header && payload && signature).toBeTruthy();
    const decode = (part: string) =>
      JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(decode(header ?? "")).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload ?? "");
    expect(claims.iss).toBe("12345");
    // Backdated against clock skew, and inside GitHub's ten-minute ceiling.
    expect(claims.iat).toBe(now / 1000 - 60);
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);
    const bytes = Uint8Array.from(
      atob((signature ?? "").replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      bytes,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });

  test("a key that is not a key is refused before any request goes out", async () => {
    let asked = 0;
    await expect(
      installationToken({
        appId: "1",
        privateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----",
        installationId: "42",
        fetch: async () => {
          asked++;
          return new Response("{}");
        },
      }),
    ).rejects.toThrow(GitHubAppError);
    expect(asked).toBe(0);
  });

  test("an installation token is minted with the JWT, and the answer's expiry is kept", async () => {
    const { pem } = await rsaKeyPair();
    const seen: { url: string; auth: string | null; method: string }[] = [];
    const token = await installationToken({
      appId: "12345",
      privateKeyPem: pem,
      installationId: "99",
      fetch: async (url, init) => {
        seen.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
          method: init?.method ?? "GET",
        });
        return Response.json({
          token: "ghs_installation",
          expires_at: "2026-09-15T02:00:00Z",
          repository_selection: "selected",
        });
      },
    });
    expect(token.token).toBe("ghs_installation");
    expect(token.expiresAt.toISOString()).toBe("2026-09-15T02:00:00.000Z");
    expect(token.repositorySelection).toBe("selected");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(seen[0]?.auth?.startsWith("Bearer ey")).toBe(true);
  });

  test("a refusal carries the status and never the request that was refused", async () => {
    const { pem } = await rsaKeyPair();
    await expect(
      installationToken({
        appId: "12345",
        privateKeyPem: pem,
        installationId: "99",
        fetch: async () => new Response("no", { status: 401, statusText: "Unauthorized" }),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("the OAuth2 lane", () => {
  test("the authorization URL carries PKCE, the state, and the manifest's scopes", () => {
    const manifest = parseManifest(GITHUB);
    const start = startAuthorization({
      manifest,
      clientId: "Iv1.test",
      redirectUri: "https://perch.example.com/api/connect/callback/github",
    });
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.test");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("repo read:org");
    expect(start.codeVerifier.length).toBeGreaterThan(20);
  });

  test("a provider that refuses the code is an OAuthError, not a crash", async () => {
    const manifest = parseManifest(GITHUB);
    // Arctic calls the global fetch, so the provider is stood in for here rather than dialled.
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: Request | string | URL) => {
      asked.push(input instanceof Request ? input.url : String(input));
      return Response.json({ error: "bad_verification_code" }, { status: 400 });
    }) as typeof fetch;
    try {
      await expect(
        exchangeCode({
          manifest,
          clientId: "Iv1.test",
          redirectUri: "https://perch.example.com/cb",
          code: "nope",
          codeVerifier: "v".repeat(43),
        }),
      ).rejects.toThrow(/refused the code/);
      expect(asked[0]).toBe("https://github.com/login/oauth/access_token");
    } finally {
      globalThis.fetch = real;
    }
  });
});
