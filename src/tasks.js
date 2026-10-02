import { badRequest, isPlainObject } from "./http.js";

export const STATUSES = ["todo", "in_progress", "blocked", "done"];
export const PRIORITIES = ["low", "medium", "high"];
export const TRANSITIONS = {
  todo: ["in_progress", "blocked"],
  in_progress: ["todo", "blocked", "done"],
  blocked: ["todo", "in_progress"],
  done: ["in_progress"],
};
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const SORTS = ["createdAt", "-createdAt", "updatedAt", "-updatedAt", "dueDate", "-dueDate", "priority", "-priority", "title", "-title"];
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CREATE_FIELDS = ["title", "description", "priority", "assignee", "dueDate", "tags", "status"];
const UPDATE_FIELDS = ["title", "description", "priority", "assignee", "dueDate", "tags", "status"];

export function isValidDate(value) {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function str(errors, field, value, { min = 0, max, nullable = false }) {
  if (value === null && nullable) return null;
  if (typeof value !== "string") {
    errors.push({ field, message: `must be a string${nullable ? " or null" : ""}` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    errors.push({ field, message: `must be ${min}-${max} characters` });
    return undefined;
  }
  return trimmed;
}

/** Validates create (partial=false) or update (partial=true) payloads. Returns sanitized fields. */
export function validateTaskInput(body, { partial }) {
  if (!isPlainObject(body)) throw badRequest("Body must be a JSON object");
  const allowed = partial ? UPDATE_FIELDS : CREATE_FIELDS;
  const errors = [];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push({ field: key, message: "unknown field" });
  }
  const out = {};
  if (!partial && body.title === undefined) errors.push({ field: "title", message: "is required" });
  if (body.title !== undefined) out.title = str(errors, "title", body.title, { min: 1, max: 200 });
  if (body.description !== undefined) out.description = str(errors, "description", body.description, { max: 2000 });
  if (body.assignee !== undefined) out.assignee = str(errors, "assignee", body.assignee, { min: 1, max: 100, nullable: true });
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) errors.push({ field: "priority", message: `must be one of ${PRIORITIES.join(", ")}` });
    else out.priority = body.priority;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) errors.push({ field: "status", message: `must be one of ${STATUSES.join(", ")}` });
    else if (!partial && body.status !== "todo") errors.push({ field: "status", message: "new tasks must start as todo" });
    else out.status = body.status;
  }
  if (body.dueDate !== undefined) {
    if (body.dueDate === null) out.dueDate = null;
    else if (typeof body.dueDate !== "string" || !isValidDate(body.dueDate)) errors.push({ field: "dueDate", message: "must be a valid YYYY-MM-DD date or null" });
    else out.dueDate = body.dueDate;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 10) errors.push({ field: "tags", message: "must be an array of at most 10 tags" });
    else if (!body.tags.every((t) => typeof t === "string" && TAG_RE.test(t))) errors.push({ field: "tags", message: "each tag must match ^[a-z0-9][a-z0-9-]{0,29}$" });
    else out.tags = [...new Set(body.tags)];
  }
  if (partial && Object.keys(body).length === 0) errors.push({ field: "(body)", message: "at least one field is required" });
  if (errors.length) throw badRequest("Invalid task payload", errors);
  return out;
}

export function todayUtc(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function isOverdue(task, today) {
  return task.status !== "done" && task.dueDate !== null && task.dueDate < today;
}

export function parseListQuery(params) {
  const allowed = ["status", "priority", "assignee", "tag", "q", "overdue", "sort", "limit", "offset"];
  const errors = [];
  for (const key of params.keys()) {
    if (!allowed.includes(key)) errors.push({ field: key, message: "unknown query parameter" });
  }
  const list = (name, values) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return null;
    const items = raw.split(",").map((s) => s.trim());
    const bad = items.filter((i) => !values.includes(i));
    if (bad.length) errors.push({ field: name, message: `invalid value(s) ${bad.join(", ")}; allowed: ${values.join(", ")}` });
    return items;
  };
  const int = (name, fallback, min, max) => {
    const raw = params.get(name);
    if (raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) {
      errors.push({ field: name, message: `must be an integer ${min}-${max}` });
      return fallback;
    }
    return n;
  };
  const q = params.get("q");
  if (q !== null && q.length > 100) errors.push({ field: "q", message: "must be at most 100 characters" });
  const overdue = params.get("overdue");
  if (overdue !== null && overdue !== "true" && overdue !== "false") errors.push({ field: "overdue", message: "must be true or false" });
  const sort = params.get("sort") || "-createdAt";
  if (!SORTS.includes(sort)) errors.push({ field: "sort", message: `must be one of ${SORTS.join(", ")}` });
  const query = {
    status: list("status", STATUSES),
    priority: list("priority", PRIORITIES),
    assignee: params.get("assignee") || null,
    tag: params.get("tag") || null,
    q: q ? q.toLowerCase() : null,
    overdue: overdue === null ? null : overdue === "true",
    sort,
    limit: int("limit", 50, 1, 100),
    offset: int("offset", 0, 0, 1_000_000),
  };
  if (errors.length) throw badRequest("Invalid query parameters", errors);
  return query;
}

export function filterTasks(tasks, query, today) {
  let result = tasks.filter((t) =>
    (!query.status || query.status.includes(t.status)) &&
    (!query.priority || query.priority.includes(t.priority)) &&
    (!query.assignee || (t.assignee || "").toLowerCase() === query.assignee.toLowerCase()) &&
    (!query.tag || t.tags.includes(query.tag)) &&
    (!query.q || t.title.toLowerCase().includes(query.q) || t.description.toLowerCase().includes(query.q)) &&
    (query.overdue === null || isOverdue(t, today) === query.overdue));
  const desc = query.sort.startsWith("-");
  const key = desc ? query.sort.slice(1) : query.sort;
  const value = (t) => (key === "priority" ? PRIORITY_RANK[t.priority] : t[key]);
  result = [...result].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === vb) return a.id < b.id ? -1 : 1;
    if (va === null || va === undefined) return 1; // nulls last regardless of direction
    if (vb === null || vb === undefined) return -1;
    return (va < vb ? -1 : 1) * (desc ? -1 : 1);
  });
  return { total: result.length, items: result.slice(query.offset, query.offset + query.limit) };
}

export function computeMetrics(tasks, now) {
  const today = todayUtc(now);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
  let overdue = 0;
  let unassigned = 0;
  let cycleTotal = 0;
  let cycleCount = 0;
  const weekAhead = todayUtc(now + 7 * 864e5);
  let dueNext7Days = 0;
  for (const t of tasks) {
    byStatus[t.status]++;
    byPriority[t.priority]++;
    if (isOverdue(t, today)) overdue++;
    if (!t.assignee) unassigned++;
    if (t.status !== "done" && t.dueDate && t.dueDate >= today && t.dueDate <= weekAhead) dueNext7Days++;
    if (t.status === "done" && t.completedAt) {
      cycleTotal += Date.parse(t.completedAt) - Date.parse(t.createdAt);
      cycleCount++;
    }
  }
  return {
    total: tasks.length,
    byStatus,
    byPriority,
    overdue,
    dueNext7Days,
    unassigned,
    completionRate: tasks.length ? Math.round((byStatus.done / tasks.length) * 1000) / 1000 : 0,
    avgCycleTimeHours: cycleCount ? Math.round((cycleTotal / cycleCount / 36e5) * 100) / 100 : null,
    generatedAt: new Date(now).toISOString(),
  };
}