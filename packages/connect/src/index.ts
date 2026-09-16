// @perch/connect — Provider manifests, OAuth flows (CIMD, DCR, pre-registered, token), MCP gateway, GitHub App (spec §3.5).
export const packageName = "@perch/connect";

export { CIMD_PATH, type ClientMetadata, callbackUrl, clientMetadata, webhookUrl } from "./cimd.ts";
export {
  type AuthorizationServer,
  authorizationServer,
  type ChooseClientOptions,
  type ClientChoice,
  chooseClient,
  DiscoveryError,
  type ProtectedResource,
  protectedResource,
  REGISTRATION_LANES,
  type RegisteredClient,
  type RegistrationLane,
  registerClient,
  resourceMetadataFromChallenge,
  resourceMetadataUrls,
  serverMetadataUrls,
} from "./discovery.ts";
export {
  appJwt,
  type FetchLike,
  GitHubAppError,
  type InstallationToken,
  installationToken,
  installUrl,
} from "./github-app.ts";
export {
  AUTH_KINDS,
  type AuthKind,
  apiBaseOf,
  type DbManifest,
  lanesOf,
  type Manifest,
  ManifestError,
  mcpUrlOf,
  parseManifest,
  type WebhookScheme,
} from "./manifest.ts";
export {
  allowed,
  argsHash,
  listUpstreamTools,
  McpError,
  openUpstream,
  permits,
  type UpstreamOptions,
  type UpstreamTool,
} from "./mcp.ts";
export {
  exchangeCode,
  exchangeCodeAt,
  OAuthError,
  type OAuthStart,
  type OAuthTokens,
  startAuthorization,
  startAuthorizationAt,
} from "./oauth.ts";
export { type Delivery, type Verdict, verifyDelivery, webhookSecret } from "./webhooks.ts";
