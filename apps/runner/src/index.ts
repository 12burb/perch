// @perch/runner — Runner agent: PTY, engines, fs, git, ports, preview tunnel (spec §3.2, §7.6).
export const packageName = "@perch/runner";

export { localCapabilities } from "./capabilities.ts";
export {
  connectRunner,
  measureLoad,
  type RunnerClient,
  type RunnerClientOptions,
  type RunnerClientStatus,
  type RunnerLogger,
  runnerSocketUrl,
} from "./client.ts";
export {
  defaultHandlers,
  implementedMethods,
  type RunnerHandler,
  type RunnerHandlers,
} from "./handlers.ts";
export {
  createInProcessRunner,
  IMPLEMENTED_METHODS,
  type InProcessRunner,
  type InProcessRunnerOptions,
} from "./inprocess.ts";
export {
  gitAuth,
  projectDir,
  projectsRoot,
  readProjectFiles,
  resolveInside,
  setupProject,
} from "./projects.ts";
