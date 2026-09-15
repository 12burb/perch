/**
 * @perch/preview — port discovery, the preview proxy, and share links (spec §5.6; task 1.18).
 * The inspector's injection lands with task 2.x; a share link never carries it (§5.6).
 */
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
