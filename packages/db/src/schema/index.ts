/**
 * The normative schema (spec §6), one file per group. Task 0.5 ships identity, tenancy, projects and
 * runners, chat, files, instance_settings, and better-auth's tables; task 0.6 adds jobs; task 0.9 adds audit_log; task 1.8 adds
 * sessions; task 1.15 adds brains; task 1.16 adds connections; task 1.17 adds mcp_servers; later tasks add bots, work, inbox, and repo_index with their own migrations.
 */
export * from "./audit.ts";
export * from "./auth.ts";
export * from "./brains.ts";
export * from "./chat.ts";
export * from "./connections.ts";
export * from "./files.ts";
export * from "./identity.ts";
export * from "./jobs.ts";
export * from "./mcp.ts";
export * from "./projects.ts";
export * from "./sessions.ts";
export * from "./tenancy.ts";
