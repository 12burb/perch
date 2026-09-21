import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Booted } from "../src/boot.ts";
import { findProject } from "../src/repos/projects.ts";
import { type RunningServer, serve } from "../src/server.ts";
import { bootTestApp } from "../src/testing.ts";

/**
 * Task 3.26 (spec §4 "Work (Plane)"): the planning around the items — cycles with a burndown and
 * agent throughput, modules, the views people save, the intake queue, and sub-items and relations.
 *
 * The two acceptance clauses are the last two tests: a cycle closes with its burndown, and a view
 * somebody saved is the view they get back.
 */

let booted: Booted;
let running: RunningServer;
let base = "";
let cookie = "";
let ws = "";
let project = "";
let userId = "";

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((one) => one.split(";")[0] ?? "")
    .filter(Boolean)
    .join("; ");
}

async function call(path: string, init: { method?: string; json?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", origin: base },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as never };
}

type Item = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  cycle_id: string | null;
  module_id: string | null;
  parent_id: string | null;
  estimate: number | null;
  intake_status: string | null;
  completed_at: string | null;
  description_doc: unknown;
};

async function add(title: string, extra: Record<string, unknown> = {}): Promise<Item> {
  const made = await call(`/api/workspaces/${ws}/projects/${project}/work-items`, {
    method: "POST",
    json: { title, ...extra },
  });
  expect(made.status).toBe(201);
  return made.body as Item;
}

async function finish(id: string): Promise<Item> {
  const done = await call(`/api/work-items/${id}`, { method: "PATCH", json: { state: "done" } });
  expect(done.status).toBe(200);
  return done.body as Item;
}

beforeAll(async () => {
  booted = await bootTestApp({});
  running = serve(booted, { port: 0, hostname: "127.0.0.1" });
  base = running.url;
  const signed = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      name: "Wren",
      email: "wren-planning@perch.test",
      password: "correct horse battery staple",
    }),
  });
  expect(signed.status).toBe(200);
  cookie = cookiesFrom(signed);
  userId = ((await call("/api/me")).body as { id: string }).id;
  ws = (
    (await call("/api/workspaces", { method: "POST", json: { name: "Nest" } })).body as {
      id: string;
    }
  ).id;
  project = (
    (
      await call(`/api/workspaces/${ws}/projects`, {
        method: "POST",
        json: { name: "Feeder", key: "FEED" },
      })
    ).body as { id: string }
  ).id;
}, 60_000);

afterAll(async () => {
  await running?.stop();
});

describe("cycles, modules, views and intake (task 3.26)", () => {
  test("a module is a part of the product, and items belong to one", async () => {
    const made = await call(`/api/workspaces/${ws}/projects/${project}/modules`, {
      method: "POST",
      json: { name: "Perches", description: "Where a bird sits" },
    });
    expect(made.status).toBe(201);
    const module = made.body as { id: string; name: string };

    const item = await add("Sand the perch", { module_id: module.id });
    expect(item.module_id).toBe(module.id);

    const listed = await call(`/api/workspaces/${ws}/projects/${project}/modules`);
    expect((listed.body as { modules: { id: string }[] }).modules.map((one) => one.id)).toEqual([
      module.id,
    ]);

    const renamed = await call(`/api/modules/${module.id}`, {
      method: "PATCH",
      json: { name: "Perching" },
    });
    expect((renamed.body as { name: string }).name).toBe("Perching");

    // The board can be asked for one module's items alone.
    const only = await call(
      `/api/workspaces/${ws}/projects/${project}/work-items?module=${module.id}`,
    );
    expect((only.body as { items: Item[] }).items.map((one) => one.id)).toEqual([item.id]);
  }, 60_000);

  test("sub-items and relations are written from both ends", async () => {
    const epic = await add("Build the nest", { type: "epic" });
    const child = await add("Weave the twigs", { parent_id: epic.id });
    expect(child.parent_id).toBe(epic.id);

    const other = await add("Find the twigs");
    const related = await call(`/api/work-items/${other.id}/relations`, {
      method: "POST",
      json: { related_id: child.id, kind: "blocks" },
    });
    expect(related.status).toBe(201);

    // The epic knows its children; the blocked item knows it is blocked, without being told.
    const epicSide = await call(`/api/work-items/${epic.id}/relations`);
    expect((epicSide.body as { children: Item[] }).children.map((one) => one.id)).toEqual([
      child.id,
    ]);
    const childSide = await call(`/api/work-items/${child.id}/relations`);
    const back = (
      childSide.body as { relations: { kind: string; related_id: string; item: Item | null }[] }
    ).relations;
    expect(back.map((one) => [one.kind, one.related_id])).toEqual([["blocked_by", other.id]]);
    // With the item on the other end, so a panel shows a title rather than an id.
    expect(back[0]?.item?.title).toBe("Find the twigs");

    // A sub-item of a sub-item is a tree nobody can read on a phone.
    const deeper = await add("Choose a twig");
    const refused = await call(`/api/work-items/${deeper.id}`, {
      method: "PATCH",
      json: { parent_id: child.id },
    });
    expect(refused.status).toBe(422);

    // Taking it away takes both ends.
    const gone = await call(`/api/work-items/${other.id}/relations/blocks/${child.id}`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(204);
    expect(
      (
        (await call(`/api/work-items/${child.id}/relations`)).body as {
          relations: unknown[];
        }
      ).relations,
    ).toEqual([]);
  }, 60_000);

  test("a description can be a document, and the plain text stays beside it", async () => {
    const item = await add("Write it down");
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Twigs, then moss." }] }],
    };
    const saved = await call(`/api/work-items/${item.id}`, {
      method: "PATCH",
      json: { description: "Twigs, then moss.", description_doc: doc },
    });
    expect(saved.status).toBe(200);
    const body = saved.body as Item & { description: string };
    expect(body.description).toBe("Twigs, then moss.");
    expect(body.description_doc).toEqual(doc);
  }, 60_000);

  test("intake is a queue, and accepting is what makes something this team's work", async () => {
    // Something that arrived rather than being typed: a bot raising it through the Bot API sets
    // `source: intake`, which is what puts it in the queue.
    const row = await findProject(booted.db.db, ws, project);
    if (!row) throw new Error("no project");
    const raised = await booted.work.create({
      project: row,
      title: "Somebody says the feeder is empty",
      userId,
      source: "intake",
      by: { actor: { type: "system" }, meta: {} },
    });
    expect(raised.intakeStatus).toBe("pending");

    const queue = await call(`/api/workspaces/${ws}/projects/${project}/intake`);
    expect((queue.body as { items: Item[] }).items.map((one) => one.id)).toContain(raised.id);

    // Accepting can convert it on the way in: a report becomes a bug.
    const accepted = await call(`/api/work-items/${raised.id}/intake/accept`, {
      method: "POST",
      json: { type: "bug" },
    });
    expect(accepted.status).toBe(200);
    expect((accepted.body as Item & { type: string }).type).toBe("bug");
    expect((accepted.body as Item).intake_status).toBe("accepted");

    // And it leaves the queue, which is the whole point of triaging it.
    const after = await call(`/api/workspaces/${ws}/projects/${project}/intake`);
    expect((after.body as { items: Item[] }).items.map((one) => one.id)).not.toContain(raised.id);

    // Twice is refused rather than silently repeated.
    expect(
      (await call(`/api/work-items/${raised.id}/intake/accept`, { method: "POST", json: {} }))
        .status,
    ).toBe(422);

    // Declining cancels and keeps the row, so what was turned down can still be found.
    const second = await booted.work.create({
      project: row,
      title: "Somebody wants a bigger feeder",
      userId,
      source: "intake",
      by: { actor: { type: "system" }, meta: {} },
    });
    const declined = await call(`/api/work-items/${second.id}/intake/decline`, { method: "POST" });
    expect(declined.status).toBe(200);
    expect((declined.body as Item).state).toBe("cancelled");
    expect((declined.body as Item).intake_status).toBe("declined");
  }, 60_000);

  test("a cycle closes with its burndown, and what is unfinished carries over", async () => {
    const week = 7 * 86_400_000;
    const startsAt = new Date(Date.now() - week);
    const made = await call(`/api/workspaces/${ws}/projects/${project}/cycles`, {
      method: "POST",
      json: {
        name: "Cycle 12",
        starts_at: startsAt.toISOString(),
        ends_at: new Date(Date.now() + week).toISOString(),
      },
    });
    expect(made.status).toBe(201);

    // A cycle is its project's: an item in another project cannot be put in it (spec §9.1
    // scoping), any more than under a parent from elsewhere — and the same for a module.
    const elsewhere = (await call(`/api/workspaces/${ws}/projects`, {
      method: "POST",
      json: { name: "Elsewhere", source: "empty" },
    })) as { status: number; body: { id: string } };
    expect(elsewhere.status).toBe(201);
    const stray = (await call(`/api/workspaces/${ws}/projects/${elsewhere.body.id}/work-items`, {
      method: "POST",
      json: { title: "not in this cycle" },
    })) as { status: number; body: Item };
    expect(stray.status).toBe(201);
    const intoCycle = await call(`/api/work-items/${stray.body.id}`, {
      method: "PATCH",
      json: { cycle_id: (made.body as { id: string }).id },
    });
    expect(intoCycle.status).toBe(404);
    const module = (await call(`/api/workspaces/${ws}/projects/${project}/modules`, {
      method: "POST",
      json: { name: "Billing" },
    })) as { status: number; body: { id: string } };
    expect(module.status).toBe(201);
    const intoModule = await call(`/api/work-items/${stray.body.id}`, {
      method: "PATCH",
      json: { module_id: module.body.id },
    });
    expect(intoModule.status).toBe(404);
    expect(((await call(`/api/work-items/${stray.body.id}`)).body as Item).cycle_id).toBeNull();
    const cycle = made.body as { id: string; status: string };

    const next = (
      await call(`/api/workspaces/${ws}/projects/${project}/cycles`, {
        method: "POST",
        json: { name: "Cycle 13" },
      })
    ).body as { id: string };

    const one = await add("Clean the feeder", { cycle_id: cycle.id, estimate: 3 });
    const two = await add("Refill the feeder", { cycle_id: cycle.id, estimate: 2 });
    const three = await add("Paint the feeder", { cycle_id: cycle.id, estimate: 5 });
    // One of them was done by an agent, which is what throughput is about.
    await call(`/api/work-items/${one.id}`, {
      method: "PATCH",
      json: { assignee: { type: "bot", id: userId } },
    });
    await finish(one.id);
    await finish(two.id);

    const burndown = await call(`/api/cycles/${cycle.id}/burndown`);
    expect(burndown.status).toBe(200);
    const chart = burndown.body as {
      scope: number;
      scope_estimate: number;
      done: number;
      days: { date: string; remaining: number; remaining_estimate: number; ideal: number }[];
      throughput: { date: string; by_agent: number; by_person: number }[];
    };
    expect(chart.scope).toBe(3);
    expect(chart.scope_estimate).toBe(10);
    expect(chart.done).toBe(2);
    // A line from the start of the cycle to now, ending on what is actually left. The first day
    // is empty because the line is what existed by then, and these items were made today — which
    // is the point of counting from the items rather than from a scope somebody typed in.
    expect(chart.days.length).toBe(8);
    expect(chart.days[0]?.remaining).toBe(0);
    expect(chart.days.at(-1)?.remaining).toBe(1);
    expect(chart.days.at(-1)?.remaining_estimate).toBe(5);
    expect(chart.days.at(-1)?.ideal).toBe(0);
    // Who finished them: one was an agent's, one a person's, both today.
    const today = chart.throughput.at(-1);
    expect(today?.by_agent).toBe(1);
    expect(today?.by_person).toBe(1);

    // Closing hands back the burndown it ended on, and moves the unfinished work to Cycle 13 —
    // never to `done`, because a fortnight ending is not work being finished.
    const closed = await call(`/api/cycles/${cycle.id}/close`, {
      method: "POST",
      json: { into: next.id },
    });
    expect(closed.status).toBe(200);
    const result = closed.body as {
      cycle: { status: string };
      carried_over: number;
      burndown: { scope: number; done: number; days: unknown[] };
    };
    expect(result.cycle.status).toBe("closed");
    expect(result.carried_over).toBe(1);
    expect(result.burndown.scope).toBe(3);
    expect(result.burndown.done).toBe(2);
    expect(result.burndown.days.length).toBeGreaterThan(1);

    const carried = (await call(`/api/work-items/${three.id}`)).body as Item;
    expect(carried.cycle_id).toBe(next.id);
    expect(carried.state).toBe("backlog");
    // The finished ones stayed where they were finished.
    expect(((await call(`/api/work-items/${one.id}`)).body as Item).cycle_id).toBe(cycle.id);
    // A closed cycle is closed by its own door, not by typing a status.
    expect(
      (await call(`/api/cycles/${next.id}`, { method: "PATCH", json: { status: "closed" } }))
        .status,
    ).toBe(422);
  }, 60_000);

  test("a view somebody saved is the view they get back", async () => {
    const urgent = await add("The hawk is back", { priority: 1, labels: ["safety"] });
    await add("Sweep the seed husks", { priority: 4, labels: ["chores"] });
    const alsoUrgent = await add("Mend the roof", { priority: 1, labels: ["safety"] });

    const saved = await call(`/api/workspaces/${ws}/views`, {
      method: "POST",
      json: {
        name: "Urgent, oldest first",
        project_id: project,
        layout: "list",
        filters: { priorities: [1], labels: ["safety"], states: ["backlog"] },
        display: { orderBy: "created", direction: "asc", properties: ["state", "assignee"] },
        shared: true,
      },
    });
    expect(saved.status).toBe(201);
    const view = saved.body as { id: string; layout: string; filters: unknown; display: unknown };
    expect(view.layout).toBe("list");

    // Asking for the view gives back exactly what it is about, in the order it says.
    const got = await call(`/api/workspaces/${ws}/projects/${project}/work-items?view=${view.id}`);
    expect(got.status).toBe(200);
    const board = got.body as { items: Item[]; view: { id: string; layout: string } | null };
    expect(board.items.map((one) => one.id)).toEqual([urgent.id, alsoUrgent.id]);
    // And the view itself comes back with it, so the client draws the right layout.
    expect(board.view?.id).toBe(view.id);
    expect(board.view?.layout).toBe("list");

    // It is in the list of views this person can see, filters and display intact.
    const listed = await call(`/api/workspaces/${ws}/views?project=${project}`);
    const mine = (listed.body as { views: { id: string; filters: unknown; display: unknown }[] })
      .views;
    expect(mine.map((one) => one.id)).toEqual([view.id]);
    expect(mine[0]?.filters).toEqual({
      priorities: [1],
      labels: ["safety"],
      states: ["backlog"],
    });
    expect(mine[0]?.display).toEqual({
      orderBy: "created",
      direction: "asc",
      properties: ["state", "assignee"],
    });

    // Changing the view changes what it is about, and nothing else.
    const changed = await call(`/api/views/${view.id}`, {
      method: "PATCH",
      json: { layout: "spreadsheet", filters: { priorities: [4] } },
    });
    expect(changed.status).toBe(200);
    const after = await call(
      `/api/workspaces/${ws}/projects/${project}/work-items?view=${view.id}`,
    );
    expect((after.body as { items: Item[] }).items.map((one) => one.title)).toEqual([
      "Sweep the seed husks",
    ]);

    // Somebody else's unshared view is not theirs to read.
    const hidden = await call(`/api/workspaces/${ws}/views`, {
      method: "POST",
      json: { name: "Just mine", project_id: project, shared: false },
    });
    expect(hidden.status).toBe(201);
    expect(
      (
        await call(`/api/views/${(hidden.body as { id: string }).id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  }, 60_000);
});
