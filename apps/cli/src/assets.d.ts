// Embedded files (Bun `with { type: "file" }`): the import resolves to a path readable by Bun.file.
declare module "*.wasm" {
  const path: string;
  export default path;
}
declare module "*.data" {
  const path: string;
  export default path;
}
declare module "*.tar.gz" {
  const path: string;
  export default path;
}
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
