#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, ".env"));
loadEnvFile(path.join(ROOT, ".env.local-worker"));

const ONLINE_BASE_URL = trimTrailingSlash(process.env.ONLINE_BASE_URL || "https://auto-reels-shtunda13.onrender.com");
const LOCAL_BASE_URL = trimTrailingSlash(process.env.LOCAL_BASE_URL || "http://127.0.0.1:3233");
const LOCAL_WORKER_TOKEN = String(process.env.LOCAL_WORKER_TOKEN || "").trim();
const WORKER_ID = String(process.env.LOCAL_WORKER_ID || `mac-${require("os").hostname()}`).trim();
const POLL_MS = readPositiveIntEnv("LOCAL_WORKER_POLL_MS", 5000);
const LOCAL_PORT = new URL(LOCAL_BASE_URL).port || "3233";
const LOCAL_HOST = new URL(LOCAL_BASE_URL).hostname || "127.0.0.1";
const START_LOCAL_SERVER = String(process.env.LOCAL_WORKER_START_SERVER || "true").trim().toLowerCase() !== "false";
const LOCAL_COOKIES_FROM_BROWSER = String(process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
const RUN_ONCE = String(process.env.LOCAL_WORKER_ONCE || "").trim().toLowerCase() === "true";

let localServer = null;
let busy = false;

if (!LOCAL_WORKER_TOKEN) {
  console.error("LOCAL_WORKER_TOKEN не настроен. Заполните .env.local-worker.");
  process.exit(1);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error(error.message || error);
  shutdown(1);
});

async function main() {
  if (START_LOCAL_SERVER) {
    await ensureLocalServer();
  }
  console.log(`Online worker: ${ONLINE_BASE_URL}`);
  console.log(`Local pipeline: ${LOCAL_BASE_URL}`);

  while (true) {
    try {
      if (!busy) {
        const job = await fetchNextJob();
        if (job) {
          busy = true;
          await processJob(job).catch(async (error) => {
            await failRemoteJob(job.id, error.message || String(error)).catch(() => {});
            console.error(`Job ${job.id}: ${error.message || error}`);
          });
          busy = false;
          if (RUN_ONCE) shutdown(0);
        }
      }
    } catch (error) {
      console.error(`Worker loop: ${error.message || error}`);
    }
    await sleep(POLL_MS);
  }
}

async function ensureLocalServer() {
  if (await isLocalHealthy()) return;

  const localEnv = {
    ...process.env,
    HOST: LOCAL_HOST,
    PORT: LOCAL_PORT,
    LOCAL_WORKER_DISABLE_QUEUE: "true",
    LOG_JOB_EVENTS: process.env.LOG_JOB_EVENTS || "false"
  };
  if (LOCAL_COOKIES_FROM_BROWSER) {
    localEnv.YTDLP_COOKIES_FROM_BROWSER = LOCAL_COOKIES_FROM_BROWSER;
  }

  localServer = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: localEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  localServer.stdout.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log(`[local] ${text}`);
  });
  localServer.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[local] ${text}`);
  });
  localServer.on("exit", (code) => {
    if (code !== null) console.error(`Local server exited with code ${code}`);
    localServer = null;
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isLocalHealthy()) return;
    await sleep(750);
  }
  throw new Error(`Локальный сервер не поднялся на ${LOCAL_BASE_URL}`);
}

async function isLocalHealthy() {
  try {
    const response = await fetchWithTimeout(`${LOCAL_BASE_URL}/api/health`, {}, 1500);
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchNextJob() {
  const response = await fetchWithTimeout(`${ONLINE_BASE_URL}/api/local-worker/jobs/next?workerId=${encodeURIComponent(WORKER_ID)}`, {
    headers: authHeaders()
  }, 30000);
  if (!response.ok) throw await httpError(response, "Не удалось получить задачу");
  const data = await response.json();
  return data.job || null;
}

async function processJob(remoteJob) {
  console.log(`Job ${remoteJob.id}: забрал из online`);
  const localJob = await createLocalJob(remoteJob);
  const doneJob = await waitLocalJob(localJob.id);
  if (doneJob.status !== "done") {
    throw new Error(doneJob.error || "Локальный pipeline завершился ошибкой");
  }

  await postJson(`${ONLINE_BASE_URL}/api/local-worker/jobs/${encodeURIComponent(remoteJob.id)}/manifest`, {
    job: doneJob
  });

  for (const [index, output] of (doneJob.outputs || []).entries()) {
    await uploadOutputAsset(remoteJob.id, doneJob.id, output, index);
  }

  await postJson(`${ONLINE_BASE_URL}/api/local-worker/jobs/${encodeURIComponent(remoteJob.id)}/complete`, {
    job: doneJob
  });
  console.log(`Job ${remoteJob.id}: готово`);
}

async function createLocalJob(remoteJob) {
  const response = await fetchWithTimeout(`${LOCAL_BASE_URL}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: remoteJob.url,
      ...(remoteJob.options || {})
    })
  }, 30000);
  if (!response.ok) throw await httpError(response, "Не удалось создать локальную задачу");
  const data = await response.json();
  return data.job;
}

async function waitLocalJob(jobId) {
  while (true) {
    const response = await fetchWithTimeout(`${LOCAL_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}`, {}, 30000);
    if (!response.ok) throw await httpError(response, "Не удалось прочитать локальную задачу");
    const data = await response.json();
    const job = data.job;
    if (!["queued", "running"].includes(job.status)) return job;
    await sleep(2000);
  }
}

async function uploadOutputAsset(remoteJobId, localJobId, output, index) {
  const localPath = String(output.localFile || output.file || "");
  if (!localPath) return;
  const localUrl = localPath.startsWith("http") ? localPath : `${LOCAL_BASE_URL}${localPath}`;
  const response = await fetchWithTimeout(localUrl, {}, 120000);
  if (!response.ok) throw await httpError(response, `Не удалось скачать локальный output ${index + 1}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const relative = localPath.startsWith(`/jobs/${localJobId}/`)
    ? localPath.slice(`/jobs/${localJobId}/`.length)
    : `outputs/reel-${index + 1}.mp4`;
  const uploadUrl = `${ONLINE_BASE_URL}/api/local-worker/jobs/${encodeURIComponent(remoteJobId)}/assets?index=${index}&path=${encodeURIComponent(relative)}`;
  const upload = await fetchWithTimeout(uploadUrl, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/octet-stream"
    },
    body: buffer
  }, 180000);
  if (!upload.ok) throw await httpError(upload, `Не удалось загрузить output ${index + 1} в online`);
}

async function failRemoteJob(jobId, message) {
  await postJson(`${ONLINE_BASE_URL}/api/local-worker/jobs/${encodeURIComponent(jobId)}/fail`, {
    error: message
  });
}

async function postJson(url, payload) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  }, 60000);
  if (!response.ok) throw await httpError(response, "Online API вернул ошибку");
  return response.json();
}

function authHeaders() {
  return { authorization: `Bearer ${LOCAL_WORKER_TOKEN}` };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function httpError(response, fallback) {
  const text = await response.text().catch(() => "");
  return new Error(`${fallback}: HTTP ${response.status}${text ? ` ${text.slice(0, 400)}` : ""}`);
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    let value = rawValue.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function readPositiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shutdown(code = 0) {
  if (localServer) localServer.kill("SIGTERM");
  process.exit(typeof code === "number" ? code : 0);
}
