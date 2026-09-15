// @perch/connect — Provider manifests, OAuth flows (CIMD, DCR, pre-registered, token), MCP gateway, GitHub App (spec §3.5).
export const packageName = "@perch/connect";

export { CIMD_PATH, type ClientMetadata, callbackUrl, clientMetadata, webhookUrl } from "./cimd.ts";
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
  lanesOf,
  type Manifest,
  ManifestError,
  parseManifest,
} from "./manifest.ts";
export {
  exchangeCode,
  OAuthError,
  type OAuthStart,
  type OAuthTokens,
  startAuthorization,
} from "./oauth.ts";
