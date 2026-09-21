/**
 * The preview tunnel's wire format (spec §7.6 `http.open` "carries request body then response head
 * and body; WebSocket upgrades tunneled the same way"; task 1.19, ADR-0086).
 *
 * `http.open` answers with a stream token, and everything else happens on that stream. A stream
 * carries text frames, so each frame is a one-letter tag, a colon, and the rest — and any bytes
 * ride as base64, because an HTTP body is not text and a preview serves plenty of images.
 *
 * A request goes api → runner as body chunks then `end`; the answer comes back as a `head`, body
 * chunks, and `end`. An upgrade instead answers `open` and then relays frames both ways until one
 * side sends `close`. `error` may replace any of it, once.
 */

export type TunnelFrame =
  /** A chunk of body (HTTP) or a binary WebSocket frame. */
  | { kind: "bytes"; data: Uint8Array }
  /** A text WebSocket frame. */
  | { kind: "text"; text: string }
  /** The response line and headers, before its body. */
  | { kind: "head"; status: number; statusText: string; headers: [string, string][] }
  /** The upgrade succeeded; `protocol` is the subprotocol the server chose. */
  | { kind: "open"; protocol: string }
  /** No more body in this direction. */
  | { kind: "end" }
  /** The socket closed, or should. */
  | { kind: "close"; code: number; reason: string }
  /** Something went wrong; nothing more follows. */
  | { kind: "error"; message: string };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a large body does not blow the argument limit of String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeTunnelFrame(frame: TunnelFrame): string {
  switch (frame.kind) {
    case "bytes":
      return `b:${toBase64(frame.data)}`;
    case "text":
      return `t:${frame.text}`;
    case "head":
      return `h:${JSON.stringify({
        status: frame.status,
        statusText: frame.statusText,
        headers: frame.headers,
      })}`;
    case "open":
      return `o:${JSON.stringify({ protocol: frame.protocol })}`;
    case "end":
      return "e:";
    case "close":
      return `c:${JSON.stringify({ code: frame.code, reason: frame.reason })}`;
    case "error":
      return `x:${frame.message}`;
  }
}

/** A status a Response can carry: an integer from 200 to 599 (a 1xx never reaches a fetch's answer). */
function isStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 200 && value <= 599;
}

/** The header pairs a head names, or null when any entry is not a pair of strings. */
function headerPairs(value: unknown): [string, string][] | null {
  if (!Array.isArray(value)) return null;
  const pairs: [string, string][] = [];
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [name, text] = entry as unknown[];
    if (typeof name !== "string" || typeof text !== "string") return null;
    pairs.push([name, text]);
  }
  return pairs;
}

/** Null for a frame this side does not understand: a tunnel drops what it cannot read. */
export function decodeTunnelFrame(raw: string): TunnelFrame | null {
  const colon = raw.indexOf(":");
  if (colon < 0) return null;
  const tag = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  try {
    switch (tag) {
      case "b":
        return { kind: "bytes", data: fromBase64(rest) };
      case "t":
        return { kind: "text", text: rest };
      case "h": {
        const head = JSON.parse(rest) as {
          status?: unknown;
          statusText?: unknown;
          headers?: unknown;
        };
        const headers = headerPairs(head.headers);
        if (!isStatus(head.status) || !headers) return null;
        return {
          kind: "head",
          status: head.status,
          statusText: typeof head.statusText === "string" ? head.statusText : "",
          headers,
        };
      }
      case "o": {
        const opened = JSON.parse(rest) as { protocol?: unknown };
        return {
          kind: "open",
          protocol: typeof opened.protocol === "string" ? opened.protocol : "",
        };
      }
      case "e":
        return { kind: "end" };
      case "c": {
        const closed = JSON.parse(rest) as { code?: unknown; reason?: unknown };
        return {
          kind: "close",
          code: typeof closed.code === "number" ? closed.code : 1000,
          reason: typeof closed.reason === "string" ? closed.reason : "",
        };
      }
      case "x":
        return { kind: "error", message: rest };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** How long a tunnelled request waits for its head before giving up. */
export const TUNNEL_HEAD_TIMEOUT_MS = 30_000;
