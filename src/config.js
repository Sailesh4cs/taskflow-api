import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function positiveInt(env, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

export function readConfig(env = process.env) {
  return {
    host: env.HOST || "127.0.0.1",
    port: positiveInt(env, "PORT", 3001, 65535),
    dataFile: path.resolve(ROOT, env.DATA_FILE || "data/tasks.json"),
    bodyLimit: positiveInt(env, "BODY_LIMIT_BYTES", 64 * 1024) || 64 * 1024,
    requestTimeout: positiveInt(env, "REQUEST_TIMEOUT_MS", 15_000) || 15_000,
    logRequests: env.LOG_REQUESTS !== "false",
  };
}