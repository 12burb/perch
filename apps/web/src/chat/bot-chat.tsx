/**
 * A chat with a bot (spec §5.2 "DM-a-bot: New chat starts a fresh thread; model picker per DM when
 * the bot allows"; task 2.9).
 *
 * The room is an ordinary DM — the bot is in it as a member — and every chat in it is a thread. So
 * the picker here chooses which thread is open, "New chat" opens none at all, and the next thing
 * said starts one. A bot that lets its brain be chosen puts the choice beside the chats, and it is
 * kept on the install, which is to say per room rather than per bot.
 */
import "@perch/ui/i18n/chat";
import { BotBadge, Button, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { type BotRow, messagesQuery, modelProfilesQuery } from "../lib/queries.ts";
import { titleOf } from "./chats.ts";
import { ChannelTranscript } from "./transcript.tsx";

export function BotChat(props: {
  workspaceId: string;
  channelId: string;
  bot: BotRow;
  /** Whether the bot lets the person choose its brain here (`spec.brain.pick`). */
  canPickBrain: boolean;
  /** The brain this room has chosen, when it has chosen one. */
  brain: string | null;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const chats = useQuery(messagesQuery(props.workspaceId, props.channelId)).data ?? [];
  const profiles = useQuery(modelProfilesQuery(props.workspaceId)).data ?? [];

  // Nothing chosen means the chat you were last in; `null` is a new one, waiting to be started.
  const open = chosen === undefined ? (chats.at(-1)?.id ?? null) : chosen;

  const pick = useMutation({
    mutationFn: async (brain: string | null) =>
      unwrap(
        await api.PATCH("/api/workspaces/{ws}/bots/{bot}/install/{channel}", {
          params: {
            path: { ws: props.workspaceId, bot: props.bot.id, channel: props.channelId },
          },
          body: { brain },
        }),
      ),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "channels"],
      });
    },
    onError: (err: unknown) =>
      setError(err instanceof RequestFailed ? err.message : t("common.error")),
  });

  return (
    <section
      aria-label={t("chat.withBot", { name: props.bot.name })}
      className="flex h-full flex-col"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <h2 className="text-md font-semibold">{props.bot.name}</h2>
        <BotBadge />
        <span className="text-sm text-fg-muted">{`@${props.bot.handle}`}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {props.canPickBrain ? (
            <>
              <label htmlFor={`${id}-brain`} className="text-sm text-fg-muted">
                {t("chat.brain")}
              </label>
              <select
                id={`${id}-brain`}
                className="h-8 rounded border border-border bg-surface px-2 text-md"
                value={pick.variables ?? props.brain ?? ""}
                disabled={pick.isPending}
                onChange={(event) => pick.mutate(event.target.value || null)}
              >
                <option value="">{t("chat.brainDefault")}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.name}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => setChosen(null)}>
            {t("chat.newChat")}
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <label htmlFor={`${id}-chat`} className="text-sm text-fg-muted">
          {t("chat.chats")}
        </label>
        <select
          id={`${id}-chat`}
          className="h-8 min-w-0 max-w-full flex-1 rounded border border-border bg-surface px-2 text-md"
          value={open ?? ""}
          onChange={(event) => setChosen(event.target.value || null)}
        >
          <option value="">{t("chat.newChat")}</option>
          {[...chats].reverse().map((row) => (
            <option key={row.id} value={row.id}>
              {titleOf(
                row.blocks.map((block) => String(block.text ?? "")).join(" "),
                t("chat.chatUntitled"),
              )}
            </option>
          ))}
        </select>
      </div>

      {open === null ? (
        <p className="px-3 pt-3 text-sm text-fg-subtle" data-testid="chat-fresh">
          {t("chat.newChatHint", { name: props.bot.name })}
        </p>
      ) : null}

      <ChannelTranscript
        workspaceId={props.workspaceId}
        channelId={props.channelId}
        channelName={props.bot.name}
        canModerate={false}
        member
        chat={{ rootId: open, onStarted: (rootId) => setChosen(rootId) }}
      />

      {error ? (
        <p role="alert" className="p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
