import pkg from "../package.json" with { type: "json" };

/**
 * The CLI's own version; `perch init` pins the images to it. A built binary carries its version
 * as a constant (`--define process.env.PERCH_VERSION`, from the release tag), which is the
 * version the images were published under; a checkout falls back to package.json, and "0.0.0"
 * (pre-release) pins to latest.
 */
export const CLI_VERSION =
  process.env.PERCH_VERSION ?? (pkg.version === "0.0.0" ? "latest" : pkg.version);
