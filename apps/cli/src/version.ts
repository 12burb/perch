import pkg from "../package.json" with { type: "json" };

/** The CLI's own version; `perch init` pins the images to it. "0.0.0" (pre-release) pins to latest. */
export const CLI_VERSION = pkg.version === "0.0.0" ? "latest" : pkg.version;
