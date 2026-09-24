import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 0.9: workspaces, memberships, RBAC through authorize(), and the audit log fed by the bus.
 * Acceptance: a member cannot read another workspace; audit rows appear.
 */

let booted: Booted;
const BASE = "http://localhost:3000";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(
  path: string,
  init: RequestInit & { cookie?: string; token?: string; json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", BASE);
  headers.set("x-forwarded-for", "203.0.113.7");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return booted.app.request(`${BASE}${path}`, { ...init, headers, body });
}

async function signUp(name: string, email: string) {
  const res = await call("/api/auth/sign-up/email", {
    method: "POST",
    json: { name, email, password: "correct horse battery staple" },
  });
  expect(res.status).toBe(200);
  const cookie = cookiesFrom(res);
  const me = (await (await call("/api/me", { cookie })).json()) as { id: string };
  return { cookie, id: me.id };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Audit = {
  rows: Array<{
    action: string;
    actor_id: string | null;
    target_id: string | null;
    ip: string | null;
    details: Record<string, unknown>;
  }>;
};

beforeAll(async () => {
  booted = await bootTestApp();
}, 60_000);

afterAll(async () => {
  await booted.close();
});

describe("workspaces, RBAC, audit (task 0.9)", () => {
  let dawn: { cookie: string; id: string };
  let julius: { cookie: string; id: string };
  let paige: { cookie: string; id: string };
  let nest = "";
  let other = "";

  test("setup: two workspaces with different owners", async () => {
    dawn = await signUp("Dawn", "dawn@example.test");
    julius = await signUp("Julius", "julius@example.test");
    paige = await signUp("Paige", "paige@example.test");
    nest = (
      await json<{ id: string }>(
        await call("/api/workspaces", {
          method: "POST",
          cookie: dawn.cookie,
          json: { name: "Nest" },
        }),
      )
    ).id;
    other = (
      await json<{ id: string }>(
        await call("/api/workspaces", {
          method: "POST",
          cookie: paige.cookie,
          json: { name: "Other" },
        }),
      )
    ).id;
    expect(nest).not.toBe(other);
  });

  test("a slug the app's own top-level paths use is refused; a name that derives one gets a suffix (A-wc-22)", async () => {
    // A workspace at /settings or /welcome would be shadowed by the route of that name.
    for (const slug of ["settings", "welcome", "sign-in", "api"]) {
      const res = await call("/api/workspaces", {
        method: "POST",
        cookie: dawn.cookie,
        json: { name: "Taken", slug },
      });
      expect(res.status).toBe(422);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("validation");
    }
    const derived = await json<{ id: string; slug: string }>(
      await call("/api/workspaces", {
        method: "POST",
        cookie: dawn.cookie,
        json: { name: "Settings" },
      }),
    );
    expect(derived.slug).toBe("settings-2");
    // A slug that only starts like a route is a slug like any other.
    const lab = await call(`/api/workspaces/${derived.id}`, {
      method: "PATCH",
      cookie: dawn.cookie,
      json: { slug: "settings-lab" },
    });
    expect(lab.status).toBe(200);
    const renamed = await call(`/api/workspaces/${derived.id}`, {
      method: "PATCH",
      cookie: dawn.cookie,
      json: { slug: "connections" },
    });
    expect(renamed.status).toBe(422);
  });

  test("a member cannot read another workspace: every route answers not_found", async () => {
    for (const path of [
      `/api/workspaces/${other}`,
      `/api/workspaces/${other}/members`,
      `/api/workspaces/${other}/audit`,
    ]) {
      const res = await call(path, { cookie: dawn.cookie });
      expect(res.status).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("not_found");
    }
    const patch = await call(`/api/workspaces/${other}`, {
      method: "PATCH",
      cookie: dawn.cookie,
      json: { name: "Mine now" },
    });
    expect(patch.status).toBe(404);
    const kick = await call(`/api/workspaces/${other}/members/${paige.id}`, {
      method: "DELETE",
      cookie: dawn.cookie,
    });
    expect(kick.status).toBe(404);
    // The owner still sees it untouched.
    const mine = await json<{ name: string; role: string; settings: unknown }>(
      await call(`/api/workspaces/${other}`, { cookie: paige.cookie }),
    );
    expect(mine).toMatchObject({ name: "Other", role: "owner", settings: {} });
  });

  test("owners and admins update the workspace; members may not; workspace.updated is audited", async () => {
    const invite = await json<{ accept_url: string }>(
      await call(`/api/workspaces/${nest}/invites`, {
        method: "POST",
        cookie: dawn.cookie,
        json: { email: "julius@example.test", role: "member" },
      }),
    );
    const token = invite.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, { method: "POST", cookie: julius.cookie }))
        .status,
    ).toBe(200);

    const asMember = await call(`/api/workspaces/${nest}`, {
      method: "PATCH",
      cookie: julius.cookie,
      json: { name: "Julius' Nest" },
    });
    expect(asMember.status).toBe(403);
    const denied = await json<{ error: { details?: { reason?: string; action?: string } } }>(
      asMember,
    );
    expect(denied.error.details?.reason).toBe("role");
    expect(denied.error.details?.action).toBe("workspace.update");

    const updated = await call(`/api/workspaces/${nest}`, {
      method: "PATCH",
      cookie: dawn.cookie,
      json: { name: "The Nest", settings: { theme: "dark" } },
    });
    expect(updated.status).toBe(200);
    expect(await json<{ name: string; settings: { theme: string } }>(updated)).toMatchObject({
      name: "The Nest",
      settings: { theme: "dark" },
    });

    const audit = await json<Audit>(
      await call(`/api/workspaces/${nest}/audit?action=workspace.updated`, { cookie: dawn.cookie }),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "workspace.updated",
      actor_id: dawn.id,
      target_id: nest,
      ip: "203.0.113.7",
    });
    expect(audit.rows[0]?.details.changes).toEqual(["name", "settings"]);
  });

  test("members list; role changes follow the matrix; the last owner is protected", async () => {
    const members = await json<{ members: Array<{ user_id: string; role: string }> }>(
      await call(`/api/workspaces/${nest}/members`, { cookie: julius.cookie }),
    );
    expect(members.members.map((m) => [m.user_id, m.role])).toEqual([
      [dawn.id, "owner"],
      [julius.id, "member"],
    ]);

    // A member cannot promote anyone, not even themselves.
    expect(
      (
        await call(`/api/workspaces/${nest}/members/${julius.id}`, {
          method: "PATCH",
          cookie: julius.cookie,
          json: { role: "admin" },
        })
      ).status,
    ).toBe(403);
    // The owner promotes Julius to admin.
    const promoted = await call(`/api/workspaces/${nest}/members/${julius.id}`, {
      method: "PATCH",
      cookie: dawn.cookie,
      json: { role: "admin" },
    });
    expect(promoted.status).toBe(200);
    // An admin cannot make owners or demote one; an owner cannot change their own role.
    expect(
      (
        await call(`/api/workspaces/${nest}/members/${julius.id}`, {
          method: "PATCH",
          cookie: julius.cookie,
          json: { role: "owner" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/api/workspaces/${nest}/members/${dawn.id}`, {
          method: "PATCH",
          cookie: julius.cookie,
          json: { role: "member" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/api/workspaces/${nest}/members/${dawn.id}`, {
          method: "PATCH",
          cookie: dawn.cookie,
          json: { role: "member" },
        })
      ).status,
    ).toBe(403);
    // The last owner cannot leave.
    const leave = await call(`/api/workspaces/${nest}/members/${dawn.id}`, {
      method: "DELETE",
      cookie: dawn.cookie,
    });
    expect(leave.status).toBe(409);
    expect(
      (await json<{ error: { details?: { reason?: string } } }>(leave)).error.details?.reason,
    ).toBe("last_owner");
    // Once Julius is an owner too, Dawn may step down.
    expect(
      (
        await call(`/api/workspaces/${nest}/members/${julius.id}`, {
          method: "PATCH",
          cookie: dawn.cookie,
          json: { role: "owner" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(`/api/workspaces/${nest}/members/${dawn.id}`, {
          method: "PATCH",
          cookie: julius.cookie,
          json: { role: "admin" },
        })
      ).status,
    ).toBe(200);

    const audit = await json<Audit>(
      await call(`/api/workspaces/${nest}/audit?action=member.role_changed`, {
        cookie: julius.cookie,
      }),
    );
    expect(audit.rows.map((r) => [r.details.previousRole, r.details.role])).toEqual([
      ["owner", "admin"],
      ["admin", "owner"],
      ["member", "admin"],
    ]);
  });

  test("an admin cannot remove an owner; anyone may leave; member.removed is audited", async () => {
    // Dawn is now an admin, Julius the owner.
    expect(
      (
        await call(`/api/workspaces/${nest}/members/${julius.id}`, {
          method: "DELETE",
          cookie: dawn.cookie,
        })
      ).status,
    ).toBe(403);
    const left = await call(`/api/workspaces/${nest}/members/${dawn.id}`, {
      method: "DELETE",
      cookie: dawn.cookie,
    });
    expect(left.status).toBe(204);
    expect((await call(`/api/workspaces/${nest}`, { cookie: dawn.cookie })).status).toBe(404);
    const audit = await json<Audit>(
      await call(`/api/workspaces/${nest}/audit?action=member.removed`, { cookie: julius.cookie }),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_id: dawn.id, target_id: dawn.id });
  });

  test("the audit log is owner/admin only, newest first, paginated with before", async () => {
    const invite = await json<{ accept_url: string }>(
      await call(`/api/workspaces/${nest}/invites`, {
        method: "POST",
        cookie: julius.cookie,
        json: { email: "paige@example.test" },
      }),
    );
    const token = invite.accept_url.split("/invite/")[1] ?? "";
    expect(
      (await call(`/api/invites/${token}/accept`, { method: "POST", cookie: paige.cookie })).status,
    ).toBe(200);
    expect((await call(`/api/workspaces/${nest}/audit`, { cookie: paige.cookie })).status).toBe(
      403,
    );

    const all = await json<{ rows: Array<{ action: string; ts: string }> }>(
      await call(`/api/workspaces/${nest}/audit?limit=200`, { cookie: julius.cookie }),
    );
    const actions = all.rows.map((r) => r.action);
    expect(actions[0]).toBe("member.added"); // newest first: Paige joining
    expect(actions).toContain("workspace.updated");
    expect(actions).toContain("member.role_changed");
    expect(actions).toContain("member.removed");
    expect(actions).not.toContain("audit.logged");
    const ts = all.rows.map((r) => r.ts);
    expect([...ts].sort().reverse()).toEqual(ts);

    const page = await json<{ rows: Array<{ action: string }> }>(
      await call(`/api/workspaces/${nest}/audit?limit=2`, { cookie: julius.cookie }),
    );
    expect(page.rows).toHaveLength(2);
    const older = await json<{ rows: Array<{ action: string }> }>(
      await call(
        `/api/workspaces/${nest}/audit?limit=200&before=${encodeURIComponent(ts[1] ?? "")}`,
        { cookie: julius.cookie },
      ),
    );
    expect(older.rows.length).toBe(all.rows.length - 2);
  });

  test("api tokens are gated by scope: read tokens read, admin actions need the admin scope", async () => {
    const readToken = (
      await json<{ token: string }>(
        await call("/api/me/tokens", {
          method: "POST",
          cookie: julius.cookie,
          json: { name: "ro", scopes: ["read"] },
        }),
      )
    ).token;
    expect((await call(`/api/workspaces/${nest}`, { token: readToken })).status).toBe(200);
    const denied = await call(`/api/workspaces/${nest}`, {
      method: "PATCH",
      token: readToken,
      json: { name: "Nope" },
    });
    expect(denied.status).toBe(403);
    expect(
      (await json<{ error: { details?: { reason?: string } } }>(denied)).error.details?.reason,
    ).toBe("scope");
    expect((await call(`/api/workspaces/${nest}/audit`, { token: readToken })).status).toBe(403);
    const adminToken = (
      await json<{ token: string }>(
        await call("/api/me/tokens", {
          method: "POST",
          cookie: julius.cookie,
          json: { name: "rw", scopes: ["admin"] },
        }),
      )
    ).token;
    expect((await call(`/api/workspaces/${nest}/audit`, { token: adminToken })).status).toBe(200);
  });
});
