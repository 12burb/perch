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

// work_items.description: plain text today; §4's Tiptap document rides in `doc` when it lands.
export const workItemDescriptionSchema = z.object({
  text: z.string().max(100_000).default(""),
  doc: z.unknown().optional(),
});
export type WorkItemDescription = z.infer<typeof workItemDescriptionSchema>;

// saved_views.filters: which items a view is about (spec §4 "saved views with filters and display
// properties"; task 3.26). Every field is optional and absent means "do not narrow by this".
export const viewFiltersSchema = z.object({
  states: z.array(z.string()).max(16).optional(),
  types: z.array(z.string()).max(8).optional(),
  priorities: z.array(z.number().int().min(0).max(4)).max(5).optional(),
  labels: z.array(z.string().max(64)).max(32).optional(),
  assignees: z.array(z.uuid()).max(64).optional(),
  cycleId: z.uuid().nullish(),
  moduleId: z.uuid().nullish(),
  /** A word in the title, which is what a person types when they mean "the login one". */
  search: z.string().max(200).optional(),
});
export type ViewFilters = z.infer<typeof viewFiltersSchema>;

// saved_views.display: how the view looks once it has decided what it is about.
export const viewDisplaySchema = z.object({
  groupBy: z.enum(["state", "priority", "assignee", "cycle", "module", "type", "none"]).optional(),
  orderBy: z.enum(["priority", "created", "updated", "due", "title"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  /** The columns a spreadsheet shows and a list puts beside a title. */
  properties: z.array(z.string().max(32)).max(24).optional(),
  showSubItems: z.boolean().optional(),
});
export type ViewDisplay = z.infer<typeof viewDisplaySchema>;

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

/**
 * A quick action (spec §5.1 "quick actions from .perch/project.json run commands plus custom
 * actions"; task 2.18). Either it asks the agent something (`prompt`) or it runs one of the
 * project's own commands in the terminal (`run`), never both: an action a person presses has to
 * have one obvious outcome.
 */
export const projectActionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "an action id is lowercase letters, digits, - and _"),
    name: z.string().min(1).max(80),
    /** What to ask the agent. Sent as a turn in the session pane's session. */
    prompt: z.string().min(1).max(4_000).optional(),
    /** The key of a command in `run`, executed in the project's terminal. */
    run: z.string().min(1).max(64).optional(),
    /** Which mode the turn runs in; the session's own mode otherwise. */
    mode: z.enum(["plan", "build"]).optional(),
    /** How hard to think for this one turn; the session's own level otherwise. */
    reasoning: z.enum(["auto", "low", "medium", "high"]).optional(),
  })
  .strict()
  .refine(
    (one) => (one.prompt === undefined) !== (one.run === undefined),
    "an action is either a prompt or a run command",
  );
export type ProjectAction = z.infer<typeof projectActionSchema>;

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
        /**
         * Preflight before push (spec §5.6 "configurable warn or block"; task 3.21, ADR-0140):
         * the project's own test, lint and build, then a look at each route in `routes`. Absent
         * means off — a suite and a browser on every push is a choice a project makes.
         */
        preflight: z.enum(["off", "warn", "block"]).optional(),
      })
      .strict()
      .optional(),
    /** Buttons in the session pane and commands in ⌘K (task 2.18). */
    actions: z.array(projectActionSchema).max(20).optional(),
    background: z
      .object({
        /**
         * Tool names that may run without asking anybody, as literal names or `prefix*` globs
         * (task 2.18, ADR-0111). The policy engine still applies to what the tool then does.
         */
        unattended: z.array(z.string().min(1).max(120)).max(50).optional(),
        /** End a session by itself once a round finishes with nothing waiting on a person. */
        autoSettle: z.boolean().optional(),
        /**
         * When a background session is allowed to reach a phone (spec §5.7 "the phone gets what
         * needs a human"; task 3.17, ADR-0134). `needs_you` — a permission or an error — is the
         * default; `always` adds the finish; `never` leaves the card to speak for itself.
         */
        notify: z.enum(["needs_you", "always", "never"]).optional(),
        /**
         * Run the project's own tests after a round that wrote something, and feed a failure back
         * as the next turn (spec §5.7 "failing tests → bounded auto-fix loop with budget"; task
         * 3.18, ADR-0135). Absent means off: a test run after every turn is somebody's bill.
         */
        testLoop: z
          .object({
            enabled: z.boolean().optional(),
            /** How many turns the loop may send before it stops and asks a person. */
            attempts: z.number().int().min(1).max(5).optional(),
          })
          .strict()
          .optional(),
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
      /** Where to open it in this Perch: `/<slug>/code/<project>?session=<id>` (task 3.7). */
      url: z.string().max(2000).optional(),
      /** The pull request the work became, when it became one (spec §10's Phase 3 exit). */
      prUrl: z.url().max(2000).optional(),
      prNumber: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("session_card"),
      sessionId: z.uuid(),
      text: z.string().optional(),
      /** Where to open it in this Perch: `/<slug>/code/<project>?session=<id>` (task 3.7). */
      url: z.string().max(2000).optional(),
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
  /**
   * What a provider said happened (spec §3.5 "inbound webhooks … → channel cards"; task 3.4). One
   * card per delivery: what it was, who did it, and where to go and look.
   */
  z
    .object({
      ...blockBase,
      type: z.literal("webhook_card"),
      provider: z.string().min(1).max(64),
      /** What the provider calls it: `push`, `deployment.succeeded`, `user.created`. */
      event: z.string().min(1).max(120),
      title: z.string().max(300),
      text: z.string().max(2_000).optional(),
      /** Where to go and look, when the payload said. */
      url: z.string().max(2_000).optional(),
      /** A few facts worth reading without opening anything. */
      fields: z
        .array(z.object({ label: z.string().max(60), value: z.string().max(300) }).strict())
        .max(6)
        .optional(),
    })
    .strict(),
  /**
   * What a deploy came to (spec §5.5 "preview-URL cards"; task 2.15). The card is the record: it is
   * rewritten in place as the build moves, so the thread always shows where the deploy got to.
   */
  z
    .object({
      ...blockBase,
      type: z.literal("deploy_card"),
      provider: z.string().min(1),
      /** The provider's own id, which is what a refresh asks about. */
      deploymentId: z.string().min(1),
      /** Where it is being deployed from, for a card that outlives the branch. */
      target: z.enum(["preview", "production"]),
      state: z.enum(["queued", "building", "ready", "error", "canceled"]),
      /** The preview URL, once the provider has one. */
      url: z.string().optional(),
      /** The provider's own build page, for logs. */
      inspectorUrl: z.string().optional(),
      branch: z.string().optional(),
      commit: z.string().optional(),
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
  /**
   * What an orchestrator split a job into, and how far each piece has got (spec §5.4 fan-out;
   * task 3.10). One row per specialist, rewritten in place as their answers land, so a thread
   * shows the shape of the work rather than five loose messages.
   */
  /**
   * A race, as one card (spec §5.7 "compare diffs, cost, preflight; pick a winner"; task 3.16).
   * One row per engine with what it cost, what its diff came to, and what the checks said — which
   * is the comparison a person is being asked to make.
   */
  z
    .object({
      ...blockBase,
      type: z.literal("race_card"),
      raceId: z.uuid(),
      state: z.enum(["running", "decided", "cancelled"]),
      /** `KEY-123`, when the race is about a work item. */
      identifier: z.string().max(64).optional(),
      decidedBy: z.enum(["person", "checks"]).optional(),
      entrants: z
        .array(
          z
            .object({
              id: z.uuid(),
              engine: z.string().max(64),
              branch: z.string().max(300),
              state: z.enum(["running", "finished", "failed", "discarded", "won"]),
              costUsd: z.number().nonnegative().optional(),
              filesChanged: z.number().int().optional(),
              additions: z.number().int().optional(),
              deletions: z.number().int().optional(),
              /** null when the project has no checks; 0 is a pass. */
              checks: z.number().int().nullable().optional(),
              detail: z.string().max(2000).optional(),
            })
            .strict(),
        )
        .max(8),
    })
    .strict(),
  /**
   * Preflight, as the checklist §5.6 asks for (task 3.21): one row per thing that was checked,
   * and whether it passed. A row that failed carries why, never a whole log.
   */
  z
    .object({
      ...blockBase,
      type: z.literal("preflight_card"),
      state: z.enum(["passed", "failed"]),
      /** What the project said to do about a failure. */
      verdict: z.enum(["warn", "block"]),
      rows: z
        .array(
          z
            .object({
              name: z.string().max(200),
              kind: z.enum(["command", "route"]),
              ok: z.boolean(),
              detail: z.string().max(2000).optional(),
              /** The picture of a route, when one was taken. */
              fileId: z.uuid().optional(),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  /**
   * A background session, as one card rewritten in place (spec §5.7 "every state change posts to
   * the task's thread"; task 3.17). What it was asked, where it got to, and — once it is over —
   * what the whole run came to, so somebody reading it in the morning needs nothing else.
   */
  z
    .object({
      ...blockBase,
      type: z.literal("background_card"),
      sessionId: z.uuid(),
      state: z.enum(["running", "needs_you", "done", "failed"]),
      /** What it was asked to do, which is the first thing anybody wants to know. */
      prompt: z.string().max(2000),
      /** Where to open it: `/<slug>/code/<project>?session=<id>`. */
      url: z.string().max(2000).optional(),
      /** The last thing it said, or what it is waiting on. */
      text: z.string().max(4000).optional(),
      /** The tool it stopped to ask about, while it is asking. */
      waitingOn: z.string().max(200).optional(),
      turns: z.number().int().optional(),
      /** Tool calls it made, as one number: the transcript is a click away. */
      tools: z.number().int().optional(),
      filesChanged: z.number().int().optional(),
      additions: z.number().int().optional(),
      deletions: z.number().int().optional(),
      costUsd: z.number().nonnegative().optional(),
      /** Wall clock from the first turn to the finish. */
      elapsedMs: z.number().int().nonnegative().optional(),
      /** Why it stopped, when it stopped badly. Never a credential. */
      detail: z.string().max(2000).optional(),
    })
    .strict(),
  /**
   * The merge queue, as one card in the item's thread (spec §5.7; task 3.15). Rewritten in place
   * as the entry moves, so a thread reads as one queue rather than four notifications.
   */
  z
    .object({
      ...blockBase,
      type: z.literal("queue_card"),
      branch: z.string().max(300),
      base: z.string().max(300),
      state: z.enum(["waiting", "landing", "landed", "failed", "cancelled"]),
      position: z.number().int(),
      /** `KEY-123`, when the branch belongs to a work item. */
      identifier: z.string().max(64).optional(),
      failure: z.enum(["conflict", "checks", "runner"]).optional(),
      /** git's words, or the tail of the check command's output. Never a credential. */
      detail: z.string().max(4000).optional(),
      /** The commit the base moved to. */
      head: z.string().max(64).optional(),
      /** The command that was run, so the card says what "checks" meant here. */
      checks: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      ...blockBase,
      type: z.literal("plan_card"),
      text: z.string().optional(),
      steps: z
        .array(
          z
            .object({
              handle: z.string().min(1).max(64),
              text: z.string().max(2000),
              status: z.enum(["waiting", "done", "failed"]),
              /** What they said, in a line: the whole answer is its own message in the thread. */
              note: z.string().max(500).optional(),
              /** What this piece may spend, when the root's budget was split (task 3.10). */
              budgetUsd: z.number().nonnegative().optional(),
            })
            .strict(),
        )
        .max(10),
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

/**
 * Whether a zone name is one this runtime knows (task 3.5). A typo in a `bot.yaml` should be a 422
 * where it was written, not a 500 the first time the schedule is saved.
 */
function knownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

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
  "fan_out",
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
    /**
     * `schedule`: what to do about a firing Perch was not up for (task 3.5). `true` runs it late,
     * which is right for a digest somebody still wants; `false` skips to the next one, which is
     * right for "good morning". Default `true`, and `catchUpGraceMinutes` says how late is still
     * worth running.
     */
    catchUp: z.boolean().optional(),
    catchUpGraceMinutes: z.number().int().min(1).max(1_440).optional(),
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
    /**
     * MCP servers this bot may reach (spec §5.3 "MCP attach (any MCP server)"; task 3.6). Each is a
     * connection this workspace has, granted to this bot; `tools` narrows further than the grant
     * does, never wider. The credential stays in the vault: the gateway carries it (AGENTS.md §1.6).
     */
    mcp: z
      .array(
        z
          .object({
            /** The connection's id, or its provider when the workspace has one of them. */
            connection: z.string().min(1).max(120),
            tools: z.array(z.string().min(1).max(120)).max(50).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    /**
     * An agent bot (spec §5.3 "Agent bots: engine: opencode|acp + projects: [...]"; task 3.7).
     * Naming an engine changes what a mention does: instead of answering from a model, the bot
     * opens a coding session on one of its projects and reports back in the thread.
     */
    engine: z.string().min(1).max(64).optional(),
    /** The projects it may work on, by name or id. The first is the default when nobody says. */
    projects: z.array(z.string().min(1).max(200)).max(20).optional(),
    /**
     * Whether a finished session that changed something is pushed and opened as a pull request
     * (spec §10's Phase 3 exit: "@dawn fix X" from chat ships a diff card and a PR). On unless the
     * bot says otherwise; a project with no repository or no connection says so on the card.
     */
    pullRequest: z.boolean().optional(),
    /**
     * The connection the push and the pull request run on, by id or provider. Without one Perch
     * looks for a connection for the repository's own host, and then for the workspace's only one.
     */
    connection: z.string().min(1).max(120).optional(),
    /**
     * The zone this bot's schedules are read in (spec §5.3's `schedule (cron)`; task 3.5). "0 9 *
     * * 1-5" means nine in the morning where the person who wrote it lives. An IANA name —
     * `Europe/London`, `America/New_York`; UTC when nobody said.
     */
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(knownTimezone, "that is not a time zone this machine knows")
      .optional(),
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
