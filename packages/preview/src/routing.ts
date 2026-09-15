/**
 * Where a preview lives (spec §5.6, §7.1; task 1.18).
 *
 * Two shapes reach the same runner port. **Wildcard mode**, when `PERCH_PREVIEW_DOMAIN` is set:
 * `https://<port>--<workspace>.<domain>`, one hostname per port, which is what gives a dev server
 * its own origin — cookies, storage, and service workers scoped to it, the way the real deployment
 * will be. **Path mode**, always available: `/p/<workspace>/<port>/…` on Perch's own origin, which
 * needs no DNS and no certificate but shares the origin with Perch.
 *
 * `<workspace>` is a slug in a hostname and an id in a path, and both are accepted in both places:
 * a link that came from somewhere else should work.
 */

/** A hostname label: what a workspace slug or a port may look like in DNS. */
const LABEL = /^[a-z0-9][a-z0-9-]*$/;

export type PreviewTarget = {
  /** The workspace as the URL spelled it: a slug or an id. The caller resolves it. */
  workspace: string;
  port: number;
  /** The path to ask the dev server for, always starting with "/". */
  path: string;
  mode: "host" | "path";
};

function portOf(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Everything after the host, normalised to start with exactly one "/". */
function pathOf(rest: string): string {
  if (!rest || rest === "/") return "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * `<port>--<workspace>.<domain>` → the target. The double dash separates two things that may each
 * contain a single dash, and a port cannot contain one at all, so the split is unambiguous.
 */
export function parsePreviewHost(
  host: string | null | undefined,
  previewDomain: string | null | undefined,
  pathname = "/",
  search = "",
): PreviewTarget | null {
  if (!host || !previewDomain) return null;
  const domain = previewDomain
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  if (!domain) return null;
  // A Host header carries the port when it is not the scheme's default.
  const name = host.trim().toLowerCase().split(":")[0] ?? "";
  if (!name.endsWith(`.${domain}`)) return null;
  const label = name.slice(0, -(domain.length + 1));
  const split = label.indexOf("--");
  if (split < 0) return null;
  const port = portOf(label.slice(0, split));
  const workspace = label.slice(split + 2);
  if (port === null || !workspace || !LABEL.test(workspace)) return null;
  return { workspace, port, path: `${pathOf(pathname)}${search}`, mode: "host" };
}

/** `/p/<workspace>/<port>/rest…` → the target (spec §7.1 `GET /p/{ws}/{port}/*`). */
export function parsePreviewPath(
  pathname: string,
  search = "",
): (PreviewTarget & { prefix: string }) | null {
  const parts = pathname.split("/");
  // ["", "p", ws, port, …rest]
  if (parts[1] !== "p") return null;
  const workspace = parts[2] ?? "";
  const port = portOf(parts[3] ?? "");
  if (!workspace || port === null) return null;
  const rest = parts.slice(4).join("/");
  return {
    workspace,
    port,
    path: `${pathOf(rest)}${search}`,
    mode: "path",
    prefix: `/p/${workspace}/${port}`,
  };
}

/** Either shape, so one call handles a request whatever mode the instance runs in. */
export function parsePreviewRequest(
  url: URL,
  host: string | null | undefined,
  previewDomain: string | null | undefined,
): PreviewTarget | null {
  return (
    parsePreviewHost(host, previewDomain, url.pathname, url.search) ??
    parsePreviewPath(url.pathname, url.search)
  );
}

export type PreviewUrlOptions = {
  publicUrl: string;
  previewDomain?: string | null;
  /** Preferred in a hostname; falls back to the id when a workspace somehow has no slug. */
  workspaceSlug?: string | null;
  workspaceId: string;
  port: number;
  path?: string;
};

/**
 * Where to point a browser at a port. Wildcard mode when the instance has a preview domain and the
 * workspace has a hostname-safe slug; path mode otherwise — never a URL the instance cannot serve.
 */
export function previewUrl(options: PreviewUrlOptions): string {
  const path = pathOf(options.path ?? "/");
  const domain = options.previewDomain?.trim().replace(/^\.+|\.+$/g, "");
  const slug = options.workspaceSlug?.toLowerCase();
  if (domain && slug && LABEL.test(slug)) {
    // Perch answers preview hostnames on its own listener, so a non-default port comes along: in
    // laptop mode that is :3000, and behind Caddy there is none.
    let scheme = "https";
    let port = "";
    try {
      const base = new URL(options.publicUrl);
      scheme = base.protocol.replace(":", "");
      port = base.port ? `:${base.port}` : "";
    } catch {
      scheme = options.publicUrl.startsWith("http://") ? "http" : "https";
    }
    return `${scheme}://${options.port}--${slug}.${domain}${port}${path}`;
  }
  const base = options.publicUrl.replace(/\/+$/, "");
  return `${base}/p/${options.workspaceId}/${options.port}${path === "/" ? "/" : path}`;
}

/** Where a share link lives: the same URL with the share's token on it. */
export function shareUrl(options: PreviewUrlOptions & { token: string }): string {
  const url = new URL(previewUrl(options));
  url.searchParams.set(SHARE_QUERY, options.token);
  return url.toString();
}

/** The query parameter a share link arrives with, before it becomes a cookie. */
export const SHARE_QUERY = "perch_share";

/** The cookie that keeps a share open across the dev server's own navigations. */
export const SHARE_COOKIE = "perch_preview_share";
