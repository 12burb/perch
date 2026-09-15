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

// audit_log.details: the audited event's payload (ids and small facts; never a secret or a body)
export const auditDetailsSchema = z.record(z.string(), z.unknown());
export type AuditDetails = z.infer<typeof auditDetailsSchema>;

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
    /** ACP agents installed on the runner (task 1.9). */
    agents: z.array(z.string().min(1)).optional(),
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

// messages.blocks (spec §5.2).
const blockBase = { id: z.string().min(1).optional() };

/**
 * What happened to an interactive block (task 2.5). The api writes it when somebody acts, so the
 * message carries its own answer: everybody sees the same decision, and a client that arrives
 * afterwards sees it too without asking anything else.
 */
const blockState = z
  .object({
    byType: z.enum(["user", "bot"]),
    byId: z.uuid(),
    /** Who it was, for a message that says so without a second lookup. */
    byName: z.string().optional(),
    at: z.string(),
    values: z.record(z.string(), z.string()),
  })
  .strict();
export type BlockState = z.infer<typeof blockState>;

/** The interactive blocks carry what was done to them; `progress` is the bot's to move. */
const interactive = { ...blockBase, state: blockState.optional() };
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
      ...interactive,
      type: z.literal("button"),
      text: z.string(),
      action: z.string().min(1),
      value: z.string().optional(),
      style: z.enum(["default", "primary", "danger"]).optional(),
    })
    .strict(),
  z
    .object({
      ...interactive,
      type: z.literal("select"),
      text: z.string().optional(),
      action: z.string().min(1),
      options: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    })
    .strict(),
  z
    .object({
      ...interactive,
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
      ...interactive,
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

// bots.spec, bots.budget, bot_installs.scopes, bot_memories.metadata (spec §5.3, §6; task 2.6)

/** The native tools a bot may be given (spec §5.3). Anything not on this list does not exist. */
export const BOT_TOOLS = [
  "web_search",
  "http_fetch",
  "chat_post",
  "chat_read",
  "remember",
  "recall",
  "thread_facts",
  "mention",
  "wait_for_replies",
  "hand_off",
] as const;
export type BotTool = (typeof BOT_TOOLS)[number];

/** What sets a bot off (spec §5.3 "Triggers"). */
export const BOT_TRIGGER_KINDS = [
  "dm",
  "mention",
  "keyword",
  "channel_join",
  "reaction",
  "schedule",
  "webhook",
] as const;
export type BotTriggerKind = (typeof BOT_TRIGGER_KINDS)[number];

const botTriggerSchema = z
  .object({
    on: z.enum(BOT_TRIGGER_KINDS),
    /** `keyword`: the words or the pattern; `reaction`: the emoji; `schedule`: unused. */
    match: z.string().min(1).optional(),
    /** A `keyword` match read as a regular expression rather than as words. */
    regex: z.boolean().optional(),
    /** `schedule`: a cron expression, and what to do when it fires. */
    cron: z.string().min(1).optional(),
    prompt: z.string().min(1).max(4000).optional(),
    /** `schedule`: the channel the answer is posted in. */
    channel: z.string().min(1).optional(),
  })
  .strict();
export type BotTrigger = z.infer<typeof botTriggerSchema>;

/** What a bot keeps between turns (spec §5.3 `memory {window 30, long_term false}`). */
const botMemorySchema = z
  .object({
    /** How many messages of the thread it is shown. */
    window: z.number().int().min(1).max(200).optional(),
    /** Whether `remember` and `recall` do anything. */
    longTerm: z.boolean().optional(),
    /** The model used to embed what it remembers; without one, recall matches on the words. */
    embedModel: z.string().min(1).optional(),
  })
  .strict();

export const botBudgetSchema = z
  .object({
    /** What it may spend in a day, across every run (spec §5.3 `budget {daily_usd 5}`). */
    dailyUsd: z.number().min(0).optional(),
    /** What one run may spend. */
    perRunUsd: z.number().min(0).optional(),
    /** How many runs it may start in an hour. */
    perHourRuns: z.number().int().min(1).optional(),
    /**
     * What a whole conversation may spend when this bot starts one (spec §5.4: the thread's budget
     * is the root's, split across the hops that follow). Task 2.7.
     */
    perThreadUsd: z.number().min(0).optional(),
    /** How many hops a chain this bot starts may take, if not the default six. */
    maxHops: z.number().int().min(1).max(20).optional(),
  })
  .strict();
export type BotBudget = z.infer<typeof botBudgetSchema>;

export const botSpecSchema = z
  .object({
    /** The system prompt: who it is and how it answers. */
    persona: z.string().max(20_000).optional(),
    /** Which brain it runs on: a model profile by name, and what to ask of it. */
    brain: z
      .object({
        profile: z.string().min(1).optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.number().int().min(1).max(32_000).optional(),
        /**
         * Whether the person talking to it may choose the model instead (spec §5.2 "model picker
         * per DM when the bot allows"). The choice is kept per room, on the install. Task 2.9.
         */
        pick: z.boolean().optional(),
      })
      .strict()
      .optional(),
    tools: z.array(z.enum(BOT_TOOLS)).optional(),
    triggers: z.array(botTriggerSchema).max(20).optional(),
    /** Where it works: channel names or ids. Empty means wherever it has been installed. */
    scope: z
      .object({ channels: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
    memory: botMemorySchema.optional(),
    /** How many tool rounds one answer may take before it has to speak. */
    maxSteps: z.number().int().min(1).max(12).optional(),
    /**
     * What this bot knows how to do, in the Agent Skills shape (spec §5.3 `skills/`): a name, the
     * line that says when to use it, and the instructions themselves. Task 2.8.
     */
    skills: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            description: z.string().max(500),
            instructions: z.string().max(20_000),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type BotSpec = z.infer<typeof botSpecSchema>;

export const botInstallScopesSchema = z
  .object({
    tools: z.array(z.enum(BOT_TOOLS)).optional(),
    post: z.boolean().optional(),
    /**
     * The brain this bot runs on in this room, when the bot lets it be chosen (task 2.9). A DM is
     * one person's room, so this is that person's pick; anywhere else it is the room's.
     */
    brain: z.string().min(1).optional(),
  })
  .strict();
export type BotInstallScopes = z.infer<typeof botInstallScopesSchema>;

export const botMemoryMetadataSchema = z.record(z.string(), z.unknown());
export type BotMemoryMetadata = z.infer<typeof botMemoryMetadataSchema>;

// thread_facts.value
export const threadFactValueSchema = z.unknown();
export type ThreadFactValue = z.infer<typeof threadFactValueSchema>;

/**
 * inbox_items.payload: the line the inbox and the phone both show (task 2.10, ADR-0100). `url` is a
 * path in this Perch, never an address somewhere else.
 */
export const inboxPayloadSchema = z
  .object({
    title: z.string().max(200).optional(),
    body: z.string().max(1000).optional(),
    url: z.string().max(2000).optional(),
  })
  .strict();
export type InboxPayload = z.infer<typeof inboxPayloadSchema>;

// notifications.payload
export const notificationPayloadSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
