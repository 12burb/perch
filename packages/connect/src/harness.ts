/**
 * The manifest harness (spec §5.5 "Everything else via manifests"; task 3.11).
 *
 * A connector is a YAML file, which means a connector can be wrong in a YAML file. `parseManifest`
 * catches the shapes that are not manifests at all; this catches the ones that parse and would
 * still not work — a webhook scheme whose signature never verifies, an OAuth lane with no
 * endpoints, an `api_base` that is not a URL Perch would call.
 *
 * Every check is run against the manifest alone: no network, no provider, nothing to stub. That is
 * what lets it run over every built-in connector in CI and over a new one a person is writing,
 * from the same function.
 */
import { type Manifest, ManifestError, parseManifest } from "./manifest.ts";
import { signDelivery, verifyDelivery } from "./webhooks.ts";

export type Finding = {
  /** `error` means Perch would not work with this provider; `warning` means somebody should look. */
  level: "error" | "warning";
  /** The field it is about, in the manifest's own words. */
  field: string;
  message: string;
};

export type ManifestReport = {
  id: string;
  ok: boolean;
  findings: Finding[];
  /** The manifest itself when it parsed, so a caller can go on to use it. */
  manifest: Manifest | null;
};

function https(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The webhook scheme, exercised: a delivery signed the way the manifest describes must verify, and
 * the same delivery with one byte changed, or signed with somebody else's secret, must not. A
 * scheme that cannot do all three is a door Perch would leave open, so it is an error.
 *
 * A provider that signs nothing is different: `webhook_signature: none` is sometimes the honest
 * answer — Supabase's webhooks are Postgres triggers with whatever headers you give them, not a
 * scheme — and then the endpoint's only protection is that its URL is unguessable. That is worth
 * saying out loud, so it is a warning rather than silence.
 */
async function checkWebhook(manifest: Manifest): Promise<Finding[]> {
  const scheme = manifest.webhook;
  const findings: Finding[] = [];
  if (manifest.webhook_signature === "none") {
    return [
      {
        level: "warning",
        field: "webhook_signature",
        message:
          "this provider signs nothing, so a delivery is trusted because its URL is unguessable",
      },
    ];
  }
  const secret = "whsec_a_secret_only_the_provider_has";
  const body = '{"hello":"there"}';
  const at = new Date();
  const headers = new Headers({
    ...(scheme.id_header ? { [scheme.id_header]: "delivery-1" } : {}),
    ...(scheme.event_header ? { [scheme.event_header]: "thing.happened" } : {}),
  });
  const seconds = String(Math.floor(at.getTime() / 1000));
  if (scheme.timestamp_header) {
    headers.set(scheme.timestamp_header, `${scheme.timestamp_prefix ?? ""}${seconds}`);
  }
  const signature = await signDelivery({ manifest, headers, body, secret });
  // A provider whose timestamp rides in the signature header sends one header, not two.
  headers.set(
    scheme.header,
    scheme.timestamp_header === scheme.header
      ? `${scheme.timestamp_prefix ?? ""}${seconds},${signature}`
      : signature,
  );

  const good = await verifyDelivery({
    manifest,
    headers,
    body,
    secret,
    now: at.getTime(),
  });
  if (!good.ok) {
    findings.push({
      level: "error",
      field: "webhook",
      message: `a delivery signed by this scheme does not verify: ${good.reason}`,
    });
    return findings;
  }
  const tampered = await verifyDelivery({
    manifest,
    headers,
    body: `${body} `,
    secret,
    now: at.getTime(),
  });
  if (tampered.ok) {
    findings.push({
      level: "error",
      field: "webhook",
      message: "a changed body still verifies: this scheme signs nothing",
    });
  }
  const wrongSecret = await verifyDelivery({
    manifest,
    headers,
    body,
    secret: `${secret}-else`,
    now: at.getTime(),
  });
  if (wrongSecret.ok) {
    findings.push({
      level: "error",
      field: "webhook",
      message: "somebody else's secret verifies: this scheme checks nothing",
    });
  }
  return findings;
}

/** Everything that can be known about a manifest without asking the provider anything. */
export async function checkManifest(source: string, id?: string): Promise<ManifestReport> {
  let manifest: Manifest;
  try {
    manifest = parseManifest(source);
  } catch (error) {
    return {
      id: id ?? "?",
      ok: false,
      manifest: null,
      findings: [
        {
          level: "error",
          field: "manifest",
          message: error instanceof ManifestError ? error.message : String(error),
        },
      ],
    };
  }

  const findings: Finding[] = [];
  if (id && id !== manifest.id) {
    findings.push({
      level: "error",
      field: "id",
      message: `the directory is ${id} but the manifest says ${manifest.id}`,
    });
  }
  // `api_base` and `mcp_url` are URLs by the schema; what it cannot say is that they are ones
  // Perch would actually call rather than, say, a file: URL somebody pasted.
  for (const [field, url] of [
    ["api_base", manifest.api_base],
    ["mcp_url", manifest.mcp_url],
  ] as const) {
    if (url && !https(url)) {
      findings.push({ level: "error", field, message: "not a URL Perch could call" });
    }
  }
  // The paste lane is always available (§3.5), so a manifest that offers it should say how to
  // check a pasted token. `/` is the schema's default, which means nobody said: hitting a
  // provider's root proves the network works and nothing about the token.
  if (manifest.auth.includes("token") && (!manifest.test_path || manifest.test_path === "/")) {
    findings.push({
      level: "warning",
      field: "test_path",
      message: "a pasted token cannot be checked without one",
    });
  }
  if (manifest.oauth && !manifest.auth.includes("oauth2")) {
    findings.push({
      level: "warning",
      field: "auth",
      message: "oauth endpoints are set but the oauth2 lane is not offered",
    });
  }
  if (manifest.auth.includes("mcp_oauth") && !manifest.mcp_url) {
    findings.push({
      level: "error",
      field: "mcp_url",
      message: "the mcp_oauth lane needs the MCP server it authenticates to",
    });
  }
  if (manifest.webhook_signature !== "none" && !manifest.webhook.id_header) {
    findings.push({
      level: "warning",
      field: "webhook.id_header",
      message: "no header carries a delivery id, so the same delivery twice is two cards",
    });
  }
  findings.push(...(await checkWebhook(manifest)));

  return {
    id: manifest.id,
    ok: findings.every((one) => one.level !== "error"),
    manifest,
    findings,
  };
}

/** One line per finding, for a person reading a terminal. */
export function reportLines(report: ManifestReport): string[] {
  if (report.findings.length === 0) return [`ok    ${report.id}`];
  return report.findings.map(
    (one) =>
      `${one.level === "error" ? "FAIL" : "warn"}  ${report.id}: ${one.field} — ${one.message}`,
  );
}
