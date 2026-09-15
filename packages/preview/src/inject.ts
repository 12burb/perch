/**
 * Putting the inspector into a previewed page (spec §5.6 "injected by the proxy only for
 * authenticated preview-pane requests (nonce-bound; ~15 KB script before </head>; origin-checked
 * postMessage)"; task 2.16).
 *
 * Three rules, all of them here rather than at the call site so that no route can get them wrong:
 * only HTML is touched, only a page that came with a ticket is touched, and a share link is never
 * touched — §5.6 says a shared preview is the dev server's page and nothing else.
 */

/** The path the client is served from, on the preview's own origin so nothing is cross-origin. */
export const INSPECTOR_PATH = "/__perch/inspector.js";

export type InjectOptions = {
  /** The per-response nonce the client signs its messages with. */
  nonce: string;
  /** Where the client script lives, as this page should ask for it. */
  scriptUrl: string;
};

/** Whether this response is a page rather than an asset, an API answer, or a stream. */
export function isHtml(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return type.split(";")[0]?.trim().toLowerCase() === "text/html";
}

/**
 * The script tag, before `</head>` when there is one and at the top of `<body>` when there is not.
 * A document with neither is not a page the inspector can attach to, and is returned unchanged.
 */
export function injectInspector(html: string, options: InjectOptions): string {
  if (html.includes(`data-perch-inspector="${options.nonce}"`)) return html;
  const tag =
    `<script data-perch-inspector="${options.nonce}" ` +
    `src="${options.scriptUrl}?nonce=${encodeURIComponent(options.nonce)}" defer></script>`;
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return `${html.slice(0, head)}${tag}${html.slice(head)}`;
  const body = /<body[^>]*>/i.exec(html);
  if (body?.index !== undefined) {
    const at = body.index + body[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }
  return html;
}

/**
 * The response with the client in it, or the response as it was. The body is read into memory only
 * for HTML, which is the one kind of preview response small enough to be worth rewriting.
 */
export async function withInspector(response: Response, options: InjectOptions): Promise<Response> {
  if (!isHtml(response) || !response.body) return response;
  const html = await response.text();
  const injected = injectInspector(html, options);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  // The dev server's CSP, if it has one, has never heard of this script; the nonce is what makes it
  // allowed rather than the rule being dropped (§5.6 "CSP relaxed only for the injected script").
  const csp = headers.get("content-security-policy");
  if (csp) headers.set("content-security-policy", allowNonce(csp, options.nonce));
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** One nonce added to script-src (or default-src when that is all there is). */
export function allowNonce(policy: string, nonce: string): string {
  const directives = policy
    .split(";")
    .map((one) => one.trim())
    .filter(Boolean);
  const at = directives.findIndex((one) => /^script-src(-elem)?\b/i.test(one));
  if (at >= 0) {
    const directive = directives[at] ?? "";
    directives[at] = `${directive} 'nonce-${nonce}'`;
    return directives.join("; ");
  }
  const fallback = directives.findIndex((one) => /^default-src\b/i.test(one));
  if (fallback >= 0) {
    return [
      ...directives,
      `script-src ${directives[fallback]?.slice("default-src".length).trim() ?? ""} 'nonce-${nonce}'`,
    ]
      .join("; ")
      .trim();
  }
  return policy;
}
