/**
 * The engines an api knows (task 1.8): a static engine (the fake, later the native chat engine) or
 * a factory bound to the runner a session's project lives on (acp, opencode, cli-harness run in the
 * runner and are driven over §7.6 session.* methods). Factories are memoised per runner link so a
 * session's state lives in one engine object.
 */
import type { RunnerLink } from "@perch/events";
import { type Engine, EngineError } from "./engine.ts";

/** What an engine needs to be built for a session: the project's runner, when it runs there. */
export type EngineContext = { link?: RunnerLink };
export type EngineFactory = (context: EngineContext) => Engine;

export class EngineRegistry {
  private readonly factories = new Map<string, EngineFactory>();
  private readonly perLink = new WeakMap<RunnerLink, Map<string, Engine>>();
  private readonly unbound = new Map<string, Engine>();

  register(id: string, engine: Engine | EngineFactory): this {
    this.factories.set(id, typeof engine === "function" ? engine : () => engine);
    this.unbound.delete(id);
    return this;
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }

  resolve(id: string, context: EngineContext = {}): Engine {
    const factory = this.factories.get(id);
    if (!factory) throw new EngineError(`unknown engine ${id}`, "unknown_engine");
    if (context.link) {
      let engines = this.perLink.get(context.link);
      if (!engines) {
        engines = new Map();
        this.perLink.set(context.link, engines);
      }
      let engine = engines.get(id);
      if (!engine) {
        engine = factory(context);
        engines.set(id, engine);
      }
      return engine;
    }
    let engine = this.unbound.get(id);
    if (!engine) {
      engine = factory(context);
      this.unbound.set(id, engine);
    }
    return engine;
  }
}
