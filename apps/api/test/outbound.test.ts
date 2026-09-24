import { describe, expect, test } from "bun:test";
import { deniedAddress, isLoopbackHost, parseIPv6 } from "../src/net/address.ts";
import {
  checkOutbound,
  type FetchLike,
  OutboundRefused,
  outboundFetch,
  type Resolver,
  requireReachable,
  sameUrl,
} from "../src/net/outbound.ts";

/**
 * The shared outbound guard (ADR-0173): a URL a member supplies is fetched only when every address
 * it resolves to is public, redirects are checked hop by hop, and the exchange is bounded in time
 * and size. DNS and the network are stood in for, so nothing here leaves the machine.
 */

/** A pretend DNS: names in the table resolve to their addresses, anything else to nothing. */
function dns(table: Record<string, string[]>): Resolver {
  return async (host) => table[host] ?? [];
}

const PUBLIC_DNS = dns({
  "api.example.com": ["93.184.216.34"],
  "cdn.example.com": ["2606:2800:220:1:248:1893:25c8:1946"],
  "internal.example.com": ["10.0.0.5"],
  "split.example.com": ["93.184.216.34", "192.168.1.10"],
  "metadata.example.com": ["169.254.169.254"],
});

describe("which addresses a member's URL may reach", () => {
  test("loopback, private, link-local, CGN and reserved IPv4 ranges are refused", () => {
    for (const address of [
      "127.0.0.1",
      "127.10.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
    ]) {
      expect(deniedAddress(address)).not.toBeNull();
    }
  });

  test("the same ranges hidden inside IPv6 are refused, and so are IPv6's own", () => {
    for (const address of [
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:c0a8:0101::1",
      "fd00::1",
      "fc00::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001:db8::1",
    ]) {
      expect(deniedAddress(address)).not.toBeNull();
    }
  });

  test("public addresses pass, in both families", () => {
    for (const address of [
      "93.184.216.34",
      "8.8.8.8",
      "172.32.0.1",
      "2606:2800:220:1:248:1893:25c8:1946",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
    ]) {
      expect(deniedAddress(address)).toBeNull();
    }
  });

  test("IPv6 is parsed the way a URL spells it", () => {
    expect(parseIPv6("[::1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6(":::")).toBeNull();
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
  });
});

describe("checkOutbound", () => {
  test("a loopback base URL is refused, however it is spelled", async () => {
    for (const url of [
      "http://127.0.0.1:5432/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://0x7f.1/",
      "http://2130706433/",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      await expect(checkOutbound(url, { resolve: PUBLIC_DNS })).rejects.toBeInstanceOf(
        OutboundRefused,
      );
    }
  });

  test("a name is judged by every address it resolves to", async () => {
    await expect(
      checkOutbound("https://internal.example.com/", { resolve: PUBLIC_DNS }),
    ).rejects.toBeInstanceOf(OutboundRefused);
    await expect(
      checkOutbound("https://split.example.com/", { resolve: PUBLIC_DNS }),
    ).rejects.toBeInstanceOf(OutboundRefused);
    await expect(
      checkOutbound("https://nowhere.example.com/", { resolve: PUBLIC_DNS }),
    ).rejects.toThrow("could not be resolved");
    expect((await checkOutbound("https://api.example.com/v1", { resolve: PUBLIC_DNS })).href).toBe(
      "https://api.example.com/v1",
    );
    expect((await checkOutbound("https://cdn.example.com/", { resolve: PUBLIC_DNS })).host).toBe(
      "cdn.example.com",
    );
  });

  test("the refusal names the host and never the address it resolved to", async () => {
    const refused = await checkOutbound("https://metadata.example.com/", {
      resolve: PUBLIC_DNS,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OutboundRefused);
    expect(String((refused as Error).message)).toContain("metadata.example.com");
    expect(String((refused as Error).message)).not.toContain("169.254");
  });

  test("only web schemes, and https where it is required", async () => {
    await expect(checkOutbound("file:///etc/passwd")).rejects.toBeInstanceOf(OutboundRefused);
    await expect(checkOutbound("not a url")).rejects.toBeInstanceOf(OutboundRefused);
    await expect(
      checkOutbound("http://api.example.com/", { resolve: PUBLIC_DNS, requireHttps: true }),
    ).rejects.toThrow("https");
  });

  test("an instance that allows private addresses reaches them (laptop mode)", async () => {
    const url = await checkOutbound("http://127.0.0.1:11434/v1", {
      policy: { allowPrivate: true },
      requireHttps: true,
    });
    expect(url.port).toBe("11434");
  });

  test("the entry-point form is a 422 naming the field", async () => {
    const refused = await requireReachable("http://127.0.0.1:1/x", "endpoint").catch(
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ status: 422, details: { field: "endpoint" } });
  });
});

describe("outboundFetch", () => {
  test("a redirect into a private network is refused before it is followed", async () => {
    const asked: string[] = [];
    const transport: FetchLike = async (url) => {
      asked.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    };
    const guarded = outboundFetch({ resolve: PUBLIC_DNS, transport });
    await expect(guarded("https://api.example.com/start")).rejects.toBeInstanceOf(OutboundRefused);
    expect(asked).toEqual(["https://api.example.com/start"]);
  });

  test("a redirect to another origin drops the caller's credentials", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const transport: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get("authorization") });
      if (url.startsWith("https://api.example.com")) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://cdn.example.com/moved" },
        });
      }
      return new Response("ok");
    };
    const guarded = outboundFetch({ resolve: PUBLIC_DNS, transport });
    const res = await guarded("https://api.example.com/x", {
      headers: { authorization: "Bearer secret-value" },
    });
    expect(await res.text()).toBe("ok");
    expect(seen).toEqual([
      { url: "https://api.example.com/x", authorization: "Bearer secret-value" },
      { url: "https://cdn.example.com/moved", authorization: null },
    ]);
  });

  test("an answer larger than the cap is not read past it", async () => {
    const transport: FetchLike = async () => new Response("x".repeat(5_000));
    const guarded = outboundFetch({ resolve: PUBLIC_DNS, transport, maxBytes: 1_000 });
    const res = await guarded("https://api.example.com/big");
    await expect(res.text()).rejects.toBeInstanceOf(OutboundRefused);
    const declared: FetchLike = async () =>
      new Response("x".repeat(5_000), { headers: { "content-length": "5000" } });
    await expect(
      outboundFetch({ resolve: PUBLIC_DNS, transport: declared, maxBytes: 1_000 })(
        "https://api.example.com/big",
      ),
    ).rejects.toBeInstanceOf(OutboundRefused);
  });

  test("an endpoint that never answers is given up on at the deadline", async () => {
    const transport: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const guarded = outboundFetch({ resolve: PUBLIC_DNS, transport, timeoutMs: 50 });
    const started = Date.now();
    await expect(guarded("https://api.example.com/slow")).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("sameUrl tells a manifest's endpoint from an override of it", () => {
    expect(sameUrl("https://mcp.example.com/mcp/", "https://MCP.example.com/mcp")).toBe(true);
    expect(sameUrl("https://mcp.example.com:443/mcp", "https://mcp.example.com/mcp")).toBe(true);
    expect(sameUrl("https://mcp.example.com/mcp", "https://evil.example.com/mcp")).toBe(false);
    expect(sameUrl("https://mcp.example.com/mcp", undefined)).toBe(false);
  });
});
