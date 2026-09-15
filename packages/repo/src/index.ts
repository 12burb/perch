/**
 * @perch/repo — what Perch knows about a repository (spec §5.7; task 2.17): how a file is cut into
 * chunks an index can hold, what `@codebase` puts in front of a model, and the AGENTS.md a new
 * project is offered.
 */
export {
  type Chunk,
  type ChunkKind,
  type ChunkOptions,
  chunkFile,
  declarationOn,
  indexable,
  looksBinary,
} from "./chunk.ts";
export {
  agentsDraft,
  CODEBASE_MENTION,
  type ContextChunk,
  type ContextOptions,
  codebaseContext,
  mentionsCodebase,
  questionOf,
  type RepoFacts,
  withCodebase,
} from "./context.ts";

export const packageName = "@perch/repo";
