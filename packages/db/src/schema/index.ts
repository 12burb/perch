/**
 * The normative schema (spec §6), one file per group. Task 0.5 ships identity, tenancy, projects and
 * runners, chat, files, instance_settings, and better-auth's tables; later tasks add bots, brains, sessions,
 * connections, work, inbox, audit, jobs, and repo_index with their own migrations.
 */
export * from "./auth.ts";
export * from "./chat.ts";
export * from "./files.ts";
export * from "./identity.ts";
export * from "./projects.ts";
export * from "./tenancy.ts";
