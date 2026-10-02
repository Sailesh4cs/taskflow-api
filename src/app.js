import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, readJson, sendError, sendHtml, sendJson, methodNotAllowed, isPlainObject } from "./http.js";
import { JsonFileStore } from "./store.js";
import {
  STATUSES, PRIORITIES, TRANSITIONS, validateTaskInput, parseListQuery, filterTasks, computeMetrics, todayUtc, isOverdue,
} from "./tasks.js";

const DASHBOARD = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validateShape(doc) {
  if (!isPlainObject(doc) || !Array.isArray(doc.tasks)) return "expected { tasks: [] }";
  return null;
}

export async function createApp(config) {
  const now = config.now || (() => Date.now());
  const store = await new JsonFileStore(config.dataFile, {
    initial: () => ({ version: 1, tasks: [] }),
    validate: validateShape,
  }).load();

  const present = (task) => ({ ...task, overdue: isOverdue(task, todayUtc(now())) });

  function findIndex(id) {
    if (!ID_RE.test(id)) throw new ApiError(404, "not_found", "Task not found");
    const index = store.data.tasks.findIndex((t) => t.id === id);
    if (index === -1) throw new ApiError(404, "not_found", "Task not found");
    return index;
  }

  function checkIfMatch(req, task) {
    const header = req.headers["if-match"];
    if (header === undefined) return;
    const expected = header.replace(/^W\//, "").replace(/"/g, "").trim();
    if (expected !== String(task.version)) {
      throw new ApiError(412, "version_mismatch", "Task was modified by another request", { currentVersion: task.version });
    }
  }

  async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (pathname === "/" || pathname === "/index.html") {
      if (method !== "GET" && method !== "HEAD") throw methodNotAllowed(["GET"]);
      return sendHtml(res, DASHBOARD);
    }
    if (pathname === "/health") {
      if (method !== "GET") throw methodNotAllowed(["GET"]);
      return sendJson(res, 200, { status: "ok", tasks: store.data.tasks.length, time: new Date(now()).toISOString() });
    }
    if (pathname === "/api/meta") {
      if (method !== "GET") throw methodNotAllowed(["GET"]);
      return sendJson(res, 200, { data: { statuses: STATUSES, priorities: PRIORITIES, transitions: TRANSITIONS } });
    }
    if (pathname === "/api/metrics") {
      if (method !== "GET") throw methodNotAllowed(["GET"]);
      return sendJson(res, 200, { data: computeMetrics(store.data.tasks, now()) });
    }
    if (pathname === "/api/tasks") {
      if (method === "GET") {
        const query = parseListQuery(url.searchParams);
        const { total, items } = filterTasks(store.data.tasks, query, todayUtc(now()));
        return sendJson(res, 200, { data: items.map(present), page: { total, limit: query.limit, offset: query.offset } });
      }
      if (method === "POST") {
        const input = validateTaskInput(await readJson(req, config.bodyLimit), { partial: false });
        const timestamp = new Date(now()).toISOString();
        const task = {
          id: randomUUID(),
          title: input.title,
          description: input.description ?? "",
          status: "todo",
          priority: input.priority ?? "medium",
          assignee: input.assignee ?? null,
          dueDate: input.dueDate ?? null,
          tags: input.tags ?? [],
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
          version: 1,
        };
        await store.mutate((cur) => ({ next: { ...cur, tasks: [...cur.tasks, task] } }));
        return sendJson(res, 201, { data: present(task) }, { Location: `/api/tasks/${task.id}`, ETag: `"${task.version}"` });
      }
      throw methodNotAllowed(["GET", "POST"]);
    }
    const match = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (match) {
      const id = match[1];
      if (method === "GET") {
        const task = store.data.tasks[findIndex(id)];
        return sendJson(res, 200, { data: present(task) }, { ETag: `"${task.version}"` });
      }
      if (method === "PATCH") {
        findIndex(id);
        const input = validateTaskInput(await readJson(req, config.bodyLimit), { partial: true });
        const updated = await store.mutate((cur) => {
          const index = cur.tasks.findIndex((t) => t.id === id);
          if (index === -1) throw new ApiError(404, "not_found", "Task not found");
          const task = cur.tasks[index];
          checkIfMatch(req, task);
          if (input.status !== undefined && input.status !== task.status && !TRANSITIONS[task.status].includes(input.status)) {
            throw new ApiError(409, "invalid_transition", `Cannot move task from ${task.status} to ${input.status}`, {
              from: task.status, to: input.status, allowed: TRANSITIONS[task.status],
            });
          }
          const timestamp = new Date(now()).toISOString();
          const next = { ...task, ...input, updatedAt: timestamp, version: task.version + 1 };
          if (input.status !== undefined && input.status !== task.status) {
            next.completedAt = input.status === "done" ? timestamp : null;
          }
          const tasks = [...cur.tasks];
          tasks[index] = next;
          return { next: { ...cur, tasks }, result: next };
        });
        return sendJson(res, 200, { data: present(updated) }, { ETag: `"${updated.version}"` });
      }
      if (method === "DELETE") {
        findIndex(id);
        await store.mutate((cur) => {
          const task = cur.tasks.find((t) => t.id === id);
          if (!task) throw new ApiError(404, "not_found", "Task not found");
          checkIfMatch(req, task);
          return { next: { ...cur, tasks: cur.tasks.filter((t) => t.id !== id) } };
        });
        return sendJson(res, 204);
      }
      throw methodNotAllowed(["GET", "PATCH", "DELETE"]);
    }
    throw new ApiError(404, "not_found", "Route not found");
  }

  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, "http://localhost");
      await handle(req, res, url);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error("Unhandled error:", err);
      sendError(res, err);
    } finally {
      if (config.logRequests) {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        console.log(JSON.stringify({ t: new Date().toISOString(), method: req.method, path: url?.pathname ?? req.url, status: res.statusCode, ms: Math.round(ms * 10) / 10 }));
      }
    }
  });
  server.requestTimeout = config.requestTimeout;
  server.headersTimeout = Math.min(config.requestTimeout, 10_000);

  return { server, store };
}