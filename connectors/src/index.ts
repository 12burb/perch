/**
 * @perch/connectors — the manifests themselves (spec §5.5). A connector is a directory with a
 * manifest.yaml; the YAML is embedded here as text so a compiled `perch` binary carries its
 * connectors with it, the way packages/db carries its migrations.
 */
import clerk from "../clerk/manifest.yaml" with { type: "text" };
import cloudflare from "../cloudflare/manifest.yaml" with { type: "text" };
import discord from "../discord/manifest.yaml" with { type: "text" };
import github from "../github/manifest.yaml" with { type: "text" };
import googleWorkspace from "../google-workspace/manifest.yaml" with { type: "text" };
import heygen from "../heygen/manifest.yaml" with { type: "text" };
import jira from "../jira/manifest.yaml" with { type: "text" };
import linear from "../linear/manifest.yaml" with { type: "text" };
import netlify from "../netlify/manifest.yaml" with { type: "text" };
import notion from "../notion/manifest.yaml" with { type: "text" };
import railway from "../railway/manifest.yaml" with { type: "text" };
import sentry from "../sentry/manifest.yaml" with { type: "text" };
import slack from "../slack/manifest.yaml" with { type: "text" };
import stripe from "../stripe/manifest.yaml" with { type: "text" };
import supabase from "../supabase/manifest.yaml" with { type: "text" };
import vercel from "../vercel/manifest.yaml" with { type: "text" };
import x from "../x/manifest.yaml" with { type: "text" };

export const packageName = "@perch/connectors";

/** Every connector that ships in this repository, by id. */
export const MANIFESTS: Record<string, string> = {
  github,
  vercel,
  supabase,
  clerk,
  slack,
  linear,
  notion,
  sentry,
  stripe,
  discord,
  // The rest of the §5.5 seed list (task 3.25).
  "google-workspace": googleWorkspace,
  jira,
  cloudflare,
  railway,
  netlify,
  heygen,
  x,
};

/** The ids, in the order the Connections card should offer them. */
export const BUILT_IN = Object.keys(MANIFESTS);
