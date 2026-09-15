/**
 * @perch/inspector — the dev plugins that tag JSX with where it came from, and the client the
 * preview proxy injects into an authenticated preview pane (spec §5.6; task 2.16).
 */
export {
  CLIENT_MESSAGE,
  type ClientMessage,
  type ConsoleLine,
  type ElementNode,
  type FailedRequest,
  HOST_MESSAGE,
  type HostMessage,
  INSPECTOR_CLIENT,
  inspectorClient,
  type Selection,
} from "./client.ts";
export {
  type InspectorOptions,
  type LoaderContext,
  perchInspector,
  perchInspectorLoader,
  sourcePath,
  transformSource,
  type VitePluginLike,
  withPerchInspector,
  withPerchInspectorWebpack,
} from "./plugins.ts";
export {
  SOURCE_ATTRIBUTE,
  type TagOptions,
  type TagResult,
  taggable,
  taggableFile,
  tagSource,
} from "./tag.ts";

export const packageName = "@perch/inspector";
