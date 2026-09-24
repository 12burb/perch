/**
 * Which IP addresses a member-supplied URL may reach (ADR-0173). A URL a member typed — a
 * connection's API base or MCP server, a brain's base URL, a push endpoint — is fetched by the api,
 * from the api's own network. These checks keep that fetch on the public internet: loopback,
 * private, link-local, carrier-grade NAT, multicast and reserved ranges are refused, and so is an
 * IPv6 address that embeds one of those (IPv4-mapped, NAT64, 6to4).
 *
 * Written out rather than taken from `node:net`'s BlockList: the rules are the point of this file,
 * and they should be readable in one place.
 */

/** A dotted-quad IPv4 address as a 32-bit number, or null when it is not one. */
export function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** An IPv6 address as eight 16-bit groups, or null when it is not one. Brackets and zones go. */
export function parseIPv6(text: string): number[] | null {
  let address = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  if (!address.includes(":")) return null;
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) is two groups written the other way.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  let head = address;
  let embedded: number[] = [];
  if (tail) {
    const v4 = parseIPv4(tail[2] ?? "");
    if (v4 === null) return null;
    head = `${tail[1] ?? ""}`;
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
    embedded = [Math.floor(v4 / 65536), v4 % 65536];
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const left = groups(halves[0]);
  const right = groups(halves[1]);
  if (!left || !right) return null;
  const total = left.length + right.length + embedded.length;
  if (halves.length === 1) {
    return total === 8 ? [...left, ...embedded] : null;
  }
  if (total > 7) return null;
  return [...left, ...new Array<number>(8 - total).fill(0), ...right, ...embedded];
}

type V4Range = { base: number; bits: number; why: string };

const v4 = (cidr: string, why: string): V4Range => {
  const [address, bits] = cidr.split("/");
  const base = parseIPv4(address ?? "");
  if (base === null) throw new Error(`bad range ${cidr}`);
  return { base, bits: Number(bits), why };
};

/** IPv4 ranges that are not the public internet (RFC 6890 and friends). */
const V4_DENIED: readonly V4Range[] = [
  v4("0.0.0.0/8", "this network"),
  v4("10.0.0.0/8", "a private network"),
  v4("100.64.0.0/10", "carrier-grade NAT"),
  v4("127.0.0.0/8", "loopback"),
  v4("169.254.0.0/16", "link-local"),
  v4("172.16.0.0/12", "a private network"),
  v4("192.0.0.0/24", "IETF protocol assignments"),
  v4("192.0.2.0/24", "documentation"),
  v4("192.88.99.0/24", "6to4 relay"),
  v4("192.168.0.0/16", "a private network"),
  v4("198.18.0.0/15", "benchmarking"),
  v4("198.51.100.0/24", "documentation"),
  v4("203.0.113.0/24", "documentation"),
  v4("224.0.0.0/4", "multicast"),
  v4("240.0.0.0/4", "reserved"),
];

function inV4(value: number, range: V4Range): boolean {
  const size = 2 ** (32 - range.bits);
  return Math.floor(value / size) === Math.floor(range.base / size);
}

/** Why an IPv4 address is off-limits, or null when it is on the public internet. */
function v4Denied(value: number): string | null {
  for (const range of V4_DENIED) if (inV4(value, range)) return range.why;
  return null;
}

/** Why an IPv6 address is off-limits, or null when it is on the public internet. */
function v6Denied(groups: number[]): string | null {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = g6 * 65536 + g7;
  const zeroTo = (n: number) => groups.slice(0, n).every((g) => g === 0);
  if (zeroTo(8)) return "the unspecified address";
  if (zeroTo(7) && g7 === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): the IPv4 address is the target.
  if (zeroTo(5) && g5 === 0xffff) return v4Denied(embedded);
  if (zeroTo(6)) return "an IPv4-compatible address";
  // NAT64 (64:ff9b::/96) reaches the embedded IPv4 address; the local-use prefix is never public.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4Denied(embedded);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return "local-use NAT64";
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "the discard prefix";
  // 2001::/23 holds Teredo and the IETF's own assignments; 2001:db8::/32 is documentation.
  if (g0 === 0x2001 && g1 < 0x200) return "IETF protocol assignments";
  if (g0 === 0x2001 && g1 === 0xdb8) return "documentation";
  // 6to4 (2002::/16) carries an IPv4 address in its second and third groups.
  if (g0 === 0x2002) return v4Denied(g1 * 65536 + g2);
  if ((g0 & 0xfe00) === 0xfc00) return "a unique local address";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xffc0) === 0xfec0) return "site-local";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  return null;
}

/**
 * Why this address may not be fetched on a member's say-so, or null when it may. Anything that is
 * not an IP address at all is refused too: the caller resolves names first.
 */
export function deniedAddress(address: string): string | null {
  const four = parseIPv4(address);
  if (four !== null) return v4Denied(four);
  const six = parseIPv6(address);
  if (six !== null) return v6Denied(six);
  return "not an IP address";
}

/** Whether a hostname is this machine by name or by number (for loopback-only allowances). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const four = parseIPv4(host);
  if (four !== null) return Math.floor(four / 2 ** 24) === 127;
  const six = parseIPv6(host);
  if (!six) return false;
  if (six.slice(0, 7).every((g) => g === 0) && six[7] === 1) return true;
  // ::ffff:127.x.y.z
  return six.slice(0, 5).every((g) => g === 0) && six[5] === 0xffff && (six[6] ?? 0) >> 8 === 127;
}

/** Whether a hostname is an IP literal (as a URL spells it: IPv6 in brackets). */
export function isIpLiteral(hostname: string): boolean {
  return parseIPv4(hostname) !== null || parseIPv6(hostname) !== null;
}
