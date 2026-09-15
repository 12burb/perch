/**
 * The policy, in workspace settings (spec §5.7 "policy engine … violations show as a card with an
 * admin override path; dry-run endpoint"; task 2.11).
 *
 * A policy is written rather than configured, so this is the document itself — the same YAML a
 * project can check in as `.perch/policy.yaml` — with one thing beside it that nothing else gives
 * you: a dry run. Type what somebody might do, and the engine says whether it would be allowed and
 * which rule decided.
 */
import "@perch/ui/i18n/settings";
import { Badge, Button, Field, Input, Textarea, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { policyQuery } from "../lib/queries.ts";

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

type Kind = "exec" | "git.push" | "fs.write" | "model";
const KINDS: Kind[] = ["exec", "git.push", "fs.write", "model"];

/** The dry run's question, in the shape the api takes. */
export function askFor(kind: Kind, value: string, channel: string) {
  const where = channel.trim() ? { channel: channel.trim().replace(/^#/, "") } : {};
  switch (kind) {
    case "git.push":
      return { kind, branch: value };
    case "fs.write":
      return { kind, path: value };
    case "model":
      return { kind, ref: value, ...where };
    default:
      return { kind, command: value };
  }
}

export function PolicySection(props: { workspaceId: string; canAdmin: boolean }) {
  const queryClient = useQueryClient();
  const id = useId();
  const policy = useQuery(policyQuery(props.workspaceId));
  const [draft, setDraft] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("exec");
  const [value, setValue] = useState("git push --force");
  const [channel, setChannel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (yaml: string) =>
      unwrap(
        await api.PUT("/api/workspaces/{ws}/policy", {
          params: { path: { ws: props.workspaceId } },
          body: { yaml },
        }),
      ),
    onSuccess: async () => {
      setError(null);
      setDraft(null);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "policy"],
      });
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const check = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/policy/evaluate", {
          params: { path: { ws: props.workspaceId } },
          body: { request: askFor(kind, value, channel) },
        }),
      ),
    onError: (err: unknown) => setError(message(err)),
  });

  const yaml = draft ?? policy.data?.yaml ?? "";

  return (
    <section aria-labelledby="policy-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="policy-heading" className="text-md font-semibold">
          {t("policy.title")}
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">{t("policy.hint")}</p>
      </div>

      <form
        aria-label={t("policy.document")}
        className="flex flex-col gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          save.mutate(yaml);
        }}
      >
        <Field id={`${id}-yaml`} label={t("policy.document")} hint={t("policy.documentHint")}>
          {(control) => (
            <Textarea
              {...control}
              rows={10}
              spellCheck={false}
              className="font-mono text-sm"
              value={yaml}
              disabled={!props.canAdmin}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
        </Field>
        {props.canAdmin ? (
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={save.isPending}>
              {save.isPending ? t("policy.saving") : t("policy.save")}
            </Button>
            {save.isSuccess && draft === null ? (
              <Badge tone="accent" data-testid="policy-saved">
                {t("policy.saved")}
              </Badge>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-fg-subtle">{t("policy.readOnly")}</p>
        )}
      </form>

      <form
        aria-label={t("policy.tryIt")}
        className="flex flex-col gap-2 rounded border border-border bg-raised p-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          check.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{t("policy.tryIt")}</h3>
          <p className="text-sm text-fg-muted">{t("policy.tryItHint")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-kind`} className="text-sm font-medium">
              {t("policy.kind")}
            </label>
            <select
              id={`${id}-kind`}
              className="h-8 rounded border border-border bg-surface px-2 text-md"
              value={kind}
              onChange={(event) => setKind(event.target.value as Kind)}
            >
              {KINDS.map((one) => (
                <option key={one} value={one}>
                  {t(`policy.kind.${one}` as "policy.kind.exec")}
                </option>
              ))}
            </select>
          </div>
          <Field id={`${id}-value`} label={t(`policy.value.${kind}` as "policy.value.exec")}>
            {(control) => (
              <Input
                {...control}
                className="w-64"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>
          {kind === "model" ? (
            <Field id={`${id}-channel`} label={t("policy.channel")}>
              {(control) => (
                <Input
                  {...control}
                  className="w-40"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                />
              )}
            </Field>
          ) : null}
          <Button type="submit" size="sm" disabled={check.isPending || value.trim() === ""}>
            {t("policy.check")}
          </Button>
        </div>
        {check.data ? (
          <p data-testid="policy-answer" className="text-sm">
            {check.data.allow ? (
              <Badge tone="accent">{t("policy.allowed")}</Badge>
            ) : (
              <Badge tone="danger">
                {t("policy.refused", { rule: check.data.rule ?? "a rule" })}
              </Badge>
            )}
            {check.data.reason ? (
              <span className="pl-2 text-fg-muted">{check.data.reason}</span>
            ) : null}
          </p>
        ) : null}
      </form>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
