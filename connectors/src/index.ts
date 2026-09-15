/**
 * @perch/connectors — the manifests themselves (spec §5.5). A connector is a directory with a
 * manifest.yaml; the YAML is embedded here as text so a compiled `perch` binary carries its
 * connectors with it, the way packages/db carries its migrations.
 */
import clerk from "../clerk/manifest.yaml" with { type: "text" };
import github from "../github/manifest.yaml" with { type: "text" };
import supabase from "../supabase/manifest.yaml" with { type: "text" };
import vercel from "../vercel/manifest.yaml" with { type: "text" };

export const packageName = "@perch/connectors";

/** Every connector that ships in this repository, by id. */
export const MANIFESTS: Record<string, string> = { github, vercel, supabase, clerk };

/** The ids, in the order the Connections card should offer them. */
export const BUILT_IN = Object.keys(MANIFESTS);
