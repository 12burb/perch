/**
 * Zod schemas for every jsonb column (spec §6: "jsonb shapes are Zod schemas in packages/db/src/shapes").
 * Services parse with these at the boundary; the tables type their columns with the inferred types.
 */
import { z } from "zod";

// workspaces.settings
export const workspaceSettingsSchema = z
  .object({
    theme: z.enum(["dark", "light", "system"]).optional(),
    density: z.enum(["compact", "comfortable"]).optional(),
    defaultLocale: z.string().min(2).max(16).optional(),
    /** Model profile names or provider/model ids members may use (spec §3.4 per-workspace allow-list). */
    allowedModels: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

// api_tokens.scopes
export const API_TOKEN_SCOPES = [
  "read",
  "write",
  "admin",
  "sessions:open",
  "chat:write",
  "chat:read",
  "work:write",
  "tools:call",
] as const;
export const apiTokenScopesSchema = z.array(z.enum(API_TOKEN_SCOPES));
export type ApiTokenScopes = z.infer<typeof apiTokenScopesSchema>;

// instance_settings.value
export const instanceSettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
export type InstanceSettingValue = z.infer<typeof instanceSettingValueSchema>;

// projects.runner_policy
export const runnerPolicySchema = z
  .object({
    kind: z.enum(["hosted", "local", "remote", "any"]).optional(),
    preferredRunnerId: z.uuid().optional(),
    /** Minutes before a hosted runner for this project idles out; falls back to PERCH_RUNNER_IDLE_MINUTES. */
    idleMinutes: z.number().int().positive().optional(),
  })
  .strict();
export type RunnerPolicy = z.infer<typeof runnerPolicySchema>;

// projects.config — the checked-in .perch/project.json (spec §5.1)
export const projectConfigSchema = z
  .object({
    engine: z
      .enum(["acp", "opencode", "cli-harness", "native", "hermes", "cli", "native-code"])
      .optional(),
    modelProfile: z.string().min(1).optional(),
    permissionPolicy: z.enum(["ask", "allow", "deny"]).optional(),
    run: z.record(z.string().min(1), z.string().min(1)).optional(),
    envFile: z.string().min(1).optional(),
    preview: z
      .object({
        command: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        path: z.string().min(1).optional(),
        routes: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    background: z
      .object({
        unattended: z.array(z.string().min(1)).optional(),
        autoSettle: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

// runners.capabilities
export const runnerCapabilitiesSchema = z
  .object({
    engines: z.array(z.string().min(1)).optional(),
    pty: z.boolean().optional(),
    docker: z.boolean().optional(),
    gpu: z.boolean().optional(),
    versions: z.record(z.string(), z.string()).optional(),
    platform: z.string().optional(),
    arch: z.string().optional(),
  })
  .strict();
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

// policies.rules — the policy.yaml document; its full schema is task 2.11
export const policyRulesSchema = z.record(z.string(), z.unknown());
export type PolicyRules = z.infer<typeof policyRulesSchema>;

// messages.blocks (spec §5.2). Interactive blocks get their full schemas in task 2.5.
const blockBase = { id: z.string().min(1).optional() };
export const messageBlockSchema = z.discriminatedUnion("type", [
  z.object({ ...blockBase, type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("code"),
      code: z.string(),
      language: z.string().optional(),
      path: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("diff_card"),
      sessionId: z.uuid(),
      turn: z.number().int().nonnegative().optional(),
      summary: z.string().optional(),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("session_card"),
      sessionId: z.uuid(),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("tool_card"),
      tool: z.string().min(1),
      args: z.unknown().optional(),
      output: z.string().optional(),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("file"),
      fileId: z.uuid(),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("button"),
      text: z.string(),
      action: z.string().min(1),
      value: z.string().optional(),
      style: z.enum(["default", "primary", "danger"]).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("select"),
      text: z.string().optional(),
      action: z.string().min(1),
      options: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("form"),
      text: z.string().optional(),
      action: z.string().min(1),
      fields: z.array(
        z
          .object({
            name: z.string().min(1),
            label: z.string(),
            kind: z.enum(["text", "textarea", "select", "checkbox"]),
            options: z
              .array(z.object({ label: z.string(), value: z.string() }).strict())
              .optional(),
            required: z.boolean().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("approve_deny"),
      text: z.string(),
      action: z.string().min(1),
      decision: z.enum(["approved", "denied"]).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("progress"),
      text: z.string().optional(),
      value: z.number().min(0).max(1),
    })
    .strict(),
]);
export const messageBlocksSchema = z.array(messageBlockSchema);
export type MessageBlock = z.infer<typeof messageBlockSchema>;

// thread_facts.value
export const threadFactValueSchema = z.unknown();
export type ThreadFactValue = z.infer<typeof threadFactValueSchema>;

// notifications.payload
export const notificationPayloadSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
