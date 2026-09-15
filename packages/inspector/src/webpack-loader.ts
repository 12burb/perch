/**
 * The webpack entry point (spec §5.6; task 2.16). webpack resolves a loader by module request and
 * calls its default export, so this file is exactly that and nothing else.
 */
import { type LoaderContext, perchInspectorLoader } from "./plugins.ts";

export default function loader(this: LoaderContext, source: string): string {
  return perchInspectorLoader.call(this, source);
}
