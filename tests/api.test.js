import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const dir = await mkdtemp(path.join(tmpdir(), "taskflow-test-"));

async function start(dataFile, now = () => NOW) {
  const app = await createApp({ dataFile, bodyLimit: 4096, requestTimeout: 5000, logRequests: false, now });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : null };
  };
  return { ...app, base, call, stop: () => new Promise((r) => { app.server.close(r); app.server.closeIdleConnections(); }) };
}

after(async () => { await rm(dir, { recursive: true, force: true }); });

describe("taskflow API", () => {
  let app;
  before(async () => { app = await start(path.join(dir, "main.json")); });
  after(async () => { await app.stop(); });

  test("health and meta", async () => {
    const h = await app.call("GET", "/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.status, "ok");
    const m = await app.call("GET", "/api/meta");
    assert.deepEqual(m.body.data.transitions.todo, ["in_progress", "blocked"]);
  });

  test("dashboard is served with nonce CSP and security headers", async () => {
    const res = await app.call("GET", "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const csp = res.headers.get("content-security-policy");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.ok(res.body.includes(`<script nonce="${nonce}">`));
    assert.ok(!res.body.includes("{{NONCE}}"));
    assert.ok(!res.body.includes("innerHTML"));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
  });

  test("full CRUD lifecycle with validated transitions", async () => {
    const created = await app.call("POST", "/api/tasks", { title: "  Write docs ", priority: "high", tags: ["docs", "docs"], dueDate: "2026-03-20", assignee: "ana" });
    assert.equal(created.status, 201);
    const task = created.body.data;
    assert.equal(task.title, "Write docs");
    assert.equal(task.status, "todo");
    assert.deepEqual(task.tags, ["docs"]);
    assert.equal(task.version, 1);
    assert.equal(created.headers.get("location"), `/api/tasks/${task.id}`);

    const got = await app.call("GET", `/api/tasks/${task.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("etag"), '"1"');

    const bad = await app.call("PATCH", `/api/tasks/${task.id}`, { status: "done" });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, "invalid_transition");
    assert.deepEqual(bad.body.error.details.allowed, ["in_progress", "blocked"]);

    const wip = await app.call("PATCH", `/api/tasks/${task.id}`, { status: "in_progress" }, { "If-Match": '"1"' });
    assert.equal(wip.status, 200);
    assert.equal(wip.body.data.version, 2);

    const stale = await app.call("PATCH", `/api/tasks/${task.id}`, { title: "x" }, { "If-Match": '"1"' });
    assert.equal(stale.status, 412);
    assert.equal(stale.body.error.code, "version_mismatch");

    const done = await app.call("PATCH", `/api/tasks/${task.id}`, { status: "done" });
    assert.equal(done.body.data.status, "done");
    assert.ok(done.body.data.completedAt);

    const reopened = await app.call("PATCH", `/api/tasks/${task.id}`, { status: "in_progress", assignee: null });
    assert.equal(reopened.body.data.completedAt, null);
    assert.equal(reopened.body.data.assignee, null);

    const del = await app.call("DELETE", `/api/tasks/${task.id}`);
    assert.equal(del.status, 204);
    assert.equal((await app.call("GET", `/api/tasks/${task.id}`)).status, 404);
    assert.equal((await app.call("DELETE", `/api/tasks/${task.id}`)).status, 404);
  });

  test("rejects invalid payloads", async () => {
    const cases = [
      [{}, "title"],
      [{ title: "" }, "title"],
      [{ title: "a".repeat(201) }, "title"],
      [{ title: "ok", priority: "urgent" }, "priority"],
      [{ title: "ok", status: "done" }, "status"],
      [{ title: "ok", dueDate: "2026-02-30" }, "dueDate"],
      [{ title: "ok", tags: ["Bad Tag"] }, "tags"],
      [{ title: "ok", owner: "x" }, "owner"],
      [{ title: 5 }, "title"],
    ];
    for (const [body, field] of cases) {
      const res = await app.call("POST", "/api/tasks", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "validation_error");
      assert.ok(res.body.error.details.some((d) => d.field === field), `${field} in ${JSON.stringify(res.body.error.details)}`);
    }
    assert.equal((await app.call("POST", "/api/tasks", [1])).status, 400);
    const badJson = await app.call("POST", "/api/tasks", "{nope");
    assert.equal(badJson.body.error.code, "invalid_json");
    const noType = await fetch(app.base + "/api/tasks", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } });
    assert.equal(noType.status, 415);
    const big = await app.call("POST", "/api/tasks", { title: "x", description: "y".repeat(5000) });
    assert.equal(big.status, 413);
    const created = await app.call("POST", "/api/tasks", { title: "patch target" });
    const empty = await app.call("PATCH", `/api/tasks/${created.body.data.id}`, {});
    assert.equal(empty.status, 400);
    const unknownStatus = await app.call("PATCH", `/api/tasks/${created.body.data.id}`, { status: "archived" });
    assert.equal(unknownStatus.status, 400);
    assert.equal((await app.call("GET", "/api/tasks/not-a-uuid")).status, 404);
    const wrongMethod = await app.call("PUT", "/api/tasks");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
    assert.equal((await app.call("GET", "/nope")).status, 404);
    await app.call("DELETE", `/api/tasks/${created.body.data.id}`);
  });

  test("filtering, sorting, pagination and metrics", async () => {
    const mk = (b) => app.call("POST", "/api/tasks", b).then((r) => r.body.data);
    const a = await mk({ title: "Alpha overdue", priority: "low", dueDate: "2026-03-01", tags: ["ops"], assignee: "Bob" });
    const b = await mk({ title: "Beta soon", priority: "high", dueDate: "2026-03-12", description: "searchable needle" });
    const c = await mk({ title: "Gamma", priority: "medium" });
    await app.call("PATCH", `/api/tasks/${c.id}`, { status: "in_progress" });
    await app.call("PATCH", `/api/tasks/${c.id}`, { status: "done" });

    let res = await app.call("GET", "/api/tasks?status=todo&sort=priority");
    assert.deepEqual(res.body.data.map((t) => t.id), [b.id, a.id]);
    res = await app.call("GET", "/api/tasks?overdue=true");
    assert.deepEqual(res.body.data.map((t) => t.id), [a.id]);
    assert.equal(res.body.data[0].overdue, true);
    res = await app.call("GET", "/api/tasks?q=NEEDLE");
    assert.deepEqual(res.body.data.map((t) => t.id), [b.id]);
    res = await app.call("GET", "/api/tasks?tag=ops&assignee=bob");
    assert.deepEqual(res.body.data.map((t) => t.id), [a.id]);
    res = await app.call("GET", "/api/tasks?status=todo,done&sort=dueDate&limit=1&offset=1");
    assert.equal(res.body.page.total, 3);
    assert.deepEqual(res.body.data.map((t) => t.id), [b.id]);
    res = await app.call("GET", "/api/tasks?sort=dueDate");
    assert.equal(res.body.data.at(-1).id, c.id, "null due dates sort last");

    for (const q of ["status=nope", "limit=0", "limit=101", "offset=-1", "overdue=maybe", "sort=evil", "foo=bar", "q=" + "x".repeat(101)]) {
      const r = await app.call("GET", "/api/tasks?" + q);
      assert.equal(r.status, 400, q);
    }

    const m = (await app.call("GET", "/api/metrics")).body.data;
    assert.equal(m.total, 3);
    assert.equal(m.byStatus.todo, 2);
    assert.equal(m.byStatus.done, 1);
    assert.equal(m.overdue, 1);
    assert.equal(m.dueNext7Days, 1);
    assert.equal(m.unassigned, 2);
    assert.equal(m.completionRate, 0.333);
    assert.equal(m.avgCycleTimeHours, 0);
  });
});

describe("persistence", () => {
  test("data survives restart and file is written atomically", async () => {
    const file = path.join(dir, "persist", "tasks.json");
    let clock = NOW;
    const first = await start(file, () => clock);
    const created = (await first.call("POST", "/api/tasks", { title: "Persist me" })).body.data;
    clock += 2 * 36e5;
    await first.call("PATCH", `/api/tasks/${created.id}`, { status: "in_progress" });
    await first.call("PATCH", `/api/tasks/${created.id}`, { status: "done" });
    await Promise.all(Array.from({ length: 20 }, (_, i) => first.call("POST", "/api/tasks", { title: `bulk ${i}` })));
    await first.stop();

    const doc = JSON.parse(await readFile(file, "utf8"));
    assert.equal(doc.tasks.length, 21);
    const leftovers = (await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);

    const second = await start(file, () => clock);
    const got = await second.call("GET", `/api/tasks/${created.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.data.status, "done");
    assert.equal(got.body.data.version, 3);
    assert.equal((await second.call("GET", "/api/metrics")).body.data.avgCycleTimeHours, 2);
    assert.equal((await second.call("GET", "/api/tasks?limit=100")).body.page.total, 21);
    await second.stop();
  });

  test("refuses to start on corrupt or malformed data file", async () => {
    const bad = path.join(dir, "corrupt.json");
    await writeFile(bad, "{not json");
    await assert.rejects(createApp({ dataFile: bad, bodyLimit: 1000, requestTimeout: 1000, logRequests: false }), /not valid JSON/);
    await writeFile(bad, JSON.stringify({ tasks: "nope" }));
    await assert.rejects(createApp({ dataFile: bad, bodyLimit: 1000, requestTimeout: 1000, logRequests: false }), /invalid shape/);
  });
});