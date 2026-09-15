/**
 * The Forge (spec §5.3 "Four ways to make one: Forge UI (form + live test chat + templates)";
 * task 2.8).
 *
 * Making a bot is a form: who it is, what it is told, which brain it runs on, what it may use, and
 * what sets it off. A template fills that form in — it is a starting point, not a thing that
 * exists — and the test chat asks the bot something without saying it in a channel, so nobody has
 * to publish a bot to find out whether it works.
 */
import "@perch/ui/i18n/settings";
import { BOT_TEMPLATES, type BotTemplate } from "@perch/bots/templates";
import { Badge, BotBadge, Button, EmptyState, Field, Input, Textarea, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  type BotRow,
  botRunsQuery,
  botsQuery,
  channelsQuery,
  modelProfilesQuery,
} from "../lib/queries.ts";

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

/** The tools a bot can be given, in the order the Forge offers them (spec §5.3). */
const TOOLS = [
  "web_search",
  "http_fetch",
  "chat_read",
  "chat_post",
  "remember",
  "recall",
  "thread_facts",
  "mention",
  "wait_for_replies",
  "hand_off",
] as const;
type Tool = (typeof TOOLS)[number];
/** A template's tools are plain strings; only the ones this Forge offers make it into a draft. */
function toolsOf(names: readonly string[]): Tool[] {
  return TOOLS.filter((tool) => names.includes(tool));
}
type Trigger = { on: "mention" | "dm" | "keyword"; match?: string };

type Draft = {
  handle: string;
  name: string;
  persona: string;
  profile: string;
  tools: Tool[];
  mention: boolean;
  dm: boolean;
  keyword: string;
  dailyUsd: string;
  visibility: "private" | "workspace";
  skills: BotTemplate["skills"];
};

const EMPTY: Draft = {
  handle: "",
  name: "",
  persona: "",
  profile: "",
  tools: ["chat_read"],
  mention: true,
  dm: false,
  keyword: "",
  dailyUsd: "5",
  visibility: "private",
  skills: [],
};

function fromTemplate(template: BotTemplate): Draft {
  return {
    handle: template.handle,
    name: template.name,
    persona: template.persona,
    profile: "",
    tools: toolsOf(template.tools),
    mention: template.triggers.some((one) => one.on === "mention"),
    dm: template.triggers.some((one) => one.on === "dm"),
    keyword: template.triggers.find((one) => one.on === "keyword")?.match ?? "",
    dailyUsd: String(template.budget.dailyUsd ?? ""),
    visibility: "private",
    skills: template.skills ?? [],
  };
}

/** The draft as the api takes it (spec §7.1 `.../bots`). */
function bodyOf(draft: Draft) {
  const triggers: Trigger[] = [];
  if (draft.mention) triggers.push({ on: "mention" });
  if (draft.dm) triggers.push({ on: "dm" });
  if (draft.keyword.trim()) triggers.push({ on: "keyword", match: draft.keyword.trim() });
  const daily = Number(draft.dailyUsd);
  return {
    handle: draft.handle.trim().toLowerCase(),
    name: draft.name.trim(),
    visibility: draft.visibility,
    budget: Number.isFinite(daily) && daily > 0 ? { dailyUsd: daily } : {},
    spec: {
      ...(draft.persona.trim() ? { persona: draft.persona.trim() } : {}),
      ...(draft.profile ? { brain: { profile: draft.profile } } : {}),
      tools: draft.tools,
      triggers,
      ...(draft.skills && draft.skills.length > 0 ? { skills: draft.skills } : {}),
    },
  };
}

export function BotsSection(props: { workspaceId: string; canAdmin: boolean }) {
  const bots = useQuery(botsQuery(props.workspaceId));
  const [draft, setDraft] = useState<Draft | null>(null);
  return (
    <section aria-labelledby="bots-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="bots-heading" className="text-md font-semibold">
          {t("forge.title")}
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">{t("forge.hint")}</p>
      </div>

      {bots.data && bots.data.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {bots.data.map((bot) => (
            <li key={bot.id}>
              <BotCard workspaceId={props.workspaceId} bot={bot as BotRow} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("forge.emptyTitle")} hint={t("forge.emptyHint")} />
      )}

      <Templates onPick={(template) => setDraft(fromTemplate(template))} />
      <BotForm
        workspaceId={props.workspaceId}
        canAdmin={props.canAdmin}
        draft={draft ?? EMPTY}
        onDraft={setDraft}
      />
    </section>
  );
}

/** The six starting points (spec §5.3). Picking one fills the form in; nothing is created yet. */
function Templates(props: { onPick: (template: BotTemplate) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg-muted">{t("forge.templates")}</h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {BOT_TEMPLATES.map((template) => (
          <li key={template.id}>
            <Button
              variant="secondary"
              data-testid="bot-template"
              className="h-auto w-full flex-col items-start gap-1 p-2 text-left"
              onClick={() => props.onPick(template)}
            >
              <span className="font-medium">{template.name}</span>
              <span className="whitespace-normal text-sm text-fg-muted">{template.blurb}</span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BotForm(props: {
  workspaceId: string;
  canAdmin: boolean;
  draft: Draft;
  onDraft: (draft: Draft) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const profiles = useQuery(modelProfilesQuery(props.workspaceId));
  const [error, setError] = useState<string | null>(null);
  const draft = props.draft;
  const set = (patch: Partial<Draft>) => props.onDraft({ ...draft, ...patch });

  const create = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/bots", {
          params: { path: { ws: props.workspaceId } },
          body: bodyOf(draft),
        }),
      ),
    onSuccess: async () => {
      setError(null);
      props.onDraft(EMPTY);
      await queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "bots"] });
    },
    onError: (err: unknown) => setError(message(err)),
  });

  return (
    <form
      aria-label={t("forge.newBot")}
      className="flex flex-col gap-3 rounded border border-border bg-raised p-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h3 className="text-sm font-semibold">{t("forge.newBot")}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-name`} label={t("forge.name")}>
          {(control) => (
            <Input
              {...control}
              value={draft.name}
              required
              onChange={(event) => set({ name: event.target.value })}
            />
          )}
        </Field>
        <Field id={`${id}-handle`} label={t("forge.handle")} hint={t("forge.handleHint")}>
          {(control) => (
            <Input
              {...control}
              value={draft.handle}
              required
              onChange={(event) => set({ handle: event.target.value })}
            />
          )}
        </Field>
      </div>
      <Field id={`${id}-persona`} label={t("forge.persona")} hint={t("forge.personaHint")}>
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            value={draft.persona}
            onChange={(event) => set({ persona: event.target.value })}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-brain`} className="text-sm font-medium">
            {t("forge.brain")}
          </label>
          <select
            id={`${id}-brain`}
            value={draft.profile}
            onChange={(event) => set({ profile: event.target.value })}
            className="h-8 rounded border border-border bg-surface px-2 text-md"
          >
            <option value="">{t("forge.brainDefault")}</option>
            {(profiles.data ?? []).map((profile) => (
              <option key={profile.id} value={profile.name}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>
        <Field id={`${id}-budget`} label={t("forge.daily")} hint={t("forge.dailyHint")}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={draft.dailyUsd}
              onChange={(event) => set({ dailyUsd: event.target.value })}
            />
          )}
        </Field>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t("forge.tools")}</legend>
        <div className="flex flex-wrap gap-2">
          {TOOLS.map((tool) => (
            <label key={tool} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={draft.tools.includes(tool)}
                onChange={(event) =>
                  set({
                    tools: event.target.checked
                      ? [...draft.tools, tool]
                      : draft.tools.filter((one) => one !== tool),
                  })
                }
              />
              {tool}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t("forge.triggers")}</legend>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={draft.mention}
              onChange={(event) => set({ mention: event.target.checked })}
            />
            {t("forge.onMention")}
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={draft.dm}
              onChange={(event) => set({ dm: event.target.checked })}
            />
            {t("forge.onDm")}
          </label>
          <span className="flex items-center gap-1 text-sm">
            <label htmlFor={`${id}-keyword`}>{t("forge.onKeyword")}</label>
            <Input
              id={`${id}-keyword`}
              className="h-7 w-40"
              value={draft.keyword}
              onChange={(event) => set({ keyword: event.target.value })}
            />
          </span>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            disabled={!props.canAdmin}
            checked={draft.visibility === "workspace"}
            onChange={(event) =>
              set({ visibility: event.target.checked ? "workspace" : "private" })
            }
          />
          {t("forge.shared")}
        </label>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? t("forge.creating") : t("forge.create")}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** One bot: where it is, what it has cost, a test chat, and the switch that pauses it. */
function BotCard(props: { workspaceId: string; bot: BotRow }) {
  const queryClient = useQueryClient();
  const channels = useQuery(channelsQuery(props.workspaceId));
  const runs = useQuery(botRunsQuery(props.workspaceId, props.bot.id));
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "bots"] });

  const install = useMutation({
    mutationFn: async (input: { channelId: string; on: boolean }) =>
      input.on
        ? unwrap(
            await api.POST("/api/workspaces/{ws}/bots/{bot}/install", {
              params: { path: { ws: props.workspaceId, bot: props.bot.id } },
              body: { channel_id: input.channelId },
            }),
          )
        : unwrap(
            await api.DELETE("/api/workspaces/{ws}/bots/{bot}/install/{channel}", {
              params: {
                path: {
                  ws: props.workspaceId,
                  bot: props.bot.id,
                  channel: input.channelId,
                },
              },
            }),
          ),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const test = useMutation({
    mutationFn: async () => {
      const channelId = props.bot.channels[0] ?? channels.data?.[0]?.id ?? "";
      return unwrap(
        await api.POST("/api/workspaces/{ws}/bots/{bot}/test", {
          params: { path: { ws: props.workspaceId, bot: props.bot.id } },
          body: { text: asked, channel_id: channelId },
        }),
      );
    },
    onSuccess: async (answer) => {
      setError(null);
      setReply(answer.reply);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "bots", props.bot.id, "runs"],
      });
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const pause = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.PATCH("/api/workspaces/{ws}/bots/{bot}", {
          params: { path: { ws: props.workspaceId, bot: props.bot.id } },
          body: { status: props.bot.status === "active" ? "paused" : "active" },
        }),
      ),
    onSuccess: refresh,
    onError: (err: unknown) => setError(message(err)),
  });

  const spent = (runs.data ?? []).reduce((total, run) => total + run.cost_usd, 0);

  return (
    <article
      data-testid="bot"
      className="flex flex-col gap-2 rounded border border-border bg-raised p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{props.bot.name}</span>
        <BotBadge />
        <span className="text-sm text-fg-muted">@{props.bot.handle}</span>
        {props.bot.visibility === "workspace" ? <Badge>{t("forge.shared")}</Badge> : null}
        {props.bot.status !== "active" ? <Badge tone="warning">{t("forge.paused")}</Badge> : null}
        <span className="ml-auto text-sm text-fg-muted">
          {t("forge.spent", { amount: spent.toFixed(2) })}
        </span>
        <Button size="sm" variant="ghost" onClick={() => pause.mutate()}>
          {props.bot.status === "active" ? t("forge.pause") : t("forge.resume")}
        </Button>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t("forge.inChannels")}</legend>
        <div className="flex flex-wrap gap-2">
          {(channels.data ?? [])
            .filter((channel) => channel.name)
            .map((channel) => (
              <label key={channel.id} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={props.bot.channels.includes(channel.id)}
                  onChange={(event) =>
                    install.mutate({ channelId: channel.id, on: event.target.checked })
                  }
                />
                #{channel.name}
              </label>
            ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={`test-${props.bot.id}`} className="text-sm font-medium">
            {t("forge.test")}
          </label>
          <Input
            id={`test-${props.bot.id}`}
            value={asked}
            placeholder={t("forge.testPlaceholder")}
            onChange={(event) => setAsked(event.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          disabled={test.isPending || asked.trim() === ""}
          onClick={() => test.mutate()}
        >
          {test.isPending ? t("forge.asking") : t("forge.ask")}
        </Button>
      </div>
      {reply ? (
        <p
          data-testid="bot-test-reply"
          className="whitespace-pre-wrap rounded bg-surface-2 p-2 text-sm"
        >
          {reply}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </article>
  );
}
