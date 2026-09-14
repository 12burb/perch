// @perch/runner — Runner agent: PTY, engines, fs, git, ports, preview tunnel (spec §3.2, §7.6).
export const packageName = "@perch/runner";

export { detectToolVersions, localCapabilities } from "./capabilities.ts";
export {
  connectRunner,
  measureLoad,
  type RunnerClient,
  type RunnerClientOptions,
  type RunnerClientStatus,
  type RunnerLogger,
  runnerSocketUrl,
} from "./client.ts";
export { type ExecOptions, type ExecResult, exec } from "./exec.ts";
export {
  type FsOptions,
  fsList,
  fsRead,
  fsSearch,
  fsStat,
  fsWrite,
  ripgrep,
  type SearchMatch,
  type SearchResult,
  searchBuiltin,
} from "./fs.ts";
export {
  type GitOptions,
  gitBranch,
  gitCommit,
  gitDiff,
  gitPush,
  gitStatus,
  worktreeCreate,
  worktreeRemove,
} from "./git.ts";
export {
  defaultHandlers,
  errorCode,
  type HandlerOptions,
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
export { createNotifier, type Notify } from "./notify.ts";
export {
  DEFAULT_DENIED_COMMANDS,
  DEFAULT_READ_ONLY_PATHS,
  enforce,
  type PolicyDecision,
  PolicyDenied,
  type PolicyRequest,
  type PolicyRules,
  type RunnerPolicy,
  runnerPolicy,
} from "./policy.ts";
export {
  dedupe,
  type ListeningPort,
  listPorts,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  watchPorts,
} from "./ports.ts";
export {
  cloneEnv,
  gitAuth,
  projectDir,
  projectsRoot,
  readProjectFiles,
  resolveInside,
  runGit,
  scrubUrl,
  setupProject,
} from "./projects.ts";
