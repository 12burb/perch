// Embedded files (Bun `with { type: "file" }`): the import resolves to a path readable by Bun.file.
declare module "*.rgba" {
  const path: string;
  export default path;
}
