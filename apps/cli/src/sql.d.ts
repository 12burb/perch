// Text imports for the deploy templates embedded in the binary (Bun `with { type: "text" }`).
declare module "*.yml" {
  const contents: string;
  export default contents;
}
declare module "*/Caddyfile" {
  const contents: string;
  export default contents;
}
declare module "*/Caddyfile.preview" {
  const contents: string;
  export default contents;
}
