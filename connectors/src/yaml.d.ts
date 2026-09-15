// Connector manifests are imported as text (Bun `with { type: "text" }`), which embeds them into
// the compiled laptop binary the way packages/db embeds its migrations.
declare module "*.yaml" {
  const contents: string;
  export default contents;
}
