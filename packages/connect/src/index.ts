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
  checkManifest,
  type Finding,
  type ManifestReport,
  reportLines,
} from "./harness.ts";
export {
  AUTH_KINDS,
  type AuthKind,
  accountFrom,
  apiBaseOf,
  type DbManifest,
  keyIsTheProviders,
  lanesOf,
  type Manifest,
  ManifestError,
  mcpUrlOf,
  parseManifest,
  SIGNATURE_KINDS,
  type SignatureKind,
  tokenHeaders,
  type WebhookScheme,
} from "./manifest.ts";
export {
  allowed,
  argsHash,
  type LineStream,
  listUpstreamTools,
  McpError,
  openLocal,
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
  refreshTokens,
  startAuthorization,
  startAuthorizationAt,
} from "./oauth.ts";
export {
  type Delivery,
  ed25519Keypair,
  signDelivery,
  type Verdict,
  verifyDelivery,
  webhookSecret,
} from "./webhooks.ts";
