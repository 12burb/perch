// @perch/engines — the Engine interface (spec §3.3), the registry, the fake engine, and the
// runner-hosted engine bridge; adapters (acp, opencode, cli-harness, native, hermes) join per task.
export const packageName = "@perch/engines";
export {
  type CreateSessionParams,
  type Engine,
  type EngineCapabilities,
  EngineError,
  type EngineErrorCode,
  type EngineSession,
  type SendOptions,
} from "./engine.ts";
export {
  echoScript,
  FakeEngine,
  type FakeEngineOptions,
  type FakeScript,
  type FakeTurnContext,
} from "./fake.ts";
export { type EngineContext, type EngineFactory, EngineRegistry } from "./registry.ts";
export { type RunnerEngine, type RunnerEngineOptions, runnerEngine } from "./runner-engine.ts";
