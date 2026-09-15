/**
 * @perch/preview — port discovery, the preview proxy, the inspector's injection, and share links
 * (spec §5.6; tasks 1.18 and 2.16). A share link never carries the inspector (§5.6).
 */
export {
  allowNonce,
  INSPECTOR_PATH,
  type InjectOptions,
  injectInspector,
  isHtml,
  withInspector,
} from "./inject.ts";
export {
  downstreamResponse,
  PreviewUnreachable,
  type ProxyOptions,
  type ProxyTarget,
  proxyRequest,
  rewriteLocation,
  upstreamRequest,
  upstreamWebSocketUrl,
} from "./proxy.ts";
export {
  type PreviewTarget,
  type PreviewUrlOptions,
  parsePreviewHost,
  parsePreviewPath,
  parsePreviewRequest,
  previewUrl,
  SHARE_COOKIE,
  SHARE_QUERY,
  shareUrl,
} from "./routing.ts";
export {
  hashShareToken,
  mintShareToken,
  SHARE_DEFAULT_MS,
  SHARE_MAX_MS,
  type ShareRecord,
  type ShareVerdict,
  shareAllows,
} from "./share.ts";
export {
  mintPreviewTicket,
  type PreviewTicket,
  TICKET_COOKIE,
  TICKET_MS,
  TICKET_QUERY,
  verifyPreviewTicket,
} from "./ticket.ts";

export const packageName = "@perch/preview";
