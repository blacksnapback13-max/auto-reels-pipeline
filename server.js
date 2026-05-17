#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
loadEnvFile(path.join(ROOT, ".env"));
const IMAGE_USAGE_PATH = path.join(DATA_DIR, "image-usage.json");
const PORT = Number(process.env.PORT || 3232);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_LOGS = 600;
const END_REACTION_TAIL_SECONDS = 1;
const STORAGE_PROVIDER = normalizeStorageProvider(process.env.STORAGE_PROVIDER || "auto");
const CLOUDINARY_FOLDER = sanitizeCloudinaryFolder(process.env.CLOUDINARY_FOLDER || "auto-reels");
const CLOUDINARY_INDEX_LIMIT = Number(process.env.CLOUDINARY_INDEX_LIMIT || 50);
const COVER_IMAGE_PROVIDER = normalizeCoverImageProvider(process.env.COVER_IMAGE_PROVIDER || "auto");
const DEFAULT_IMAGE_PROVIDER_ORDER = process.env.AI_IMAGE_PROVIDER_ORDER || "gemini,cloudflare,huggingface,qwen,pollinations";
const DEFAULT_IMAGE_PROVIDER_TIMEOUT_MS = Number(process.env.IMAGE_PROVIDER_TIMEOUT_MS || 90000);
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const COVER_IMAGE_SIZE = process.env.OPENAI_COVER_SIZE || "1008x1792";
const COVER_IMAGE_QUALITY = process.env.OPENAI_COVER_QUALITY || "medium";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";
const GEMINI_IMAGE_FALLBACK_MODELS = process.env.GEMINI_IMAGE_FALLBACK_MODELS || "gemini-2.5-flash-image";
const GEMINI_IMAGE_SIZE = normalizeGeminiImageSize(process.env.GEMINI_IMAGE_SIZE || "1K");
const GEMINI_COVER_ASPECT_RATIO = "9:16";
const DEFAULT_CLOUDFLARE_IMAGE_MODEL = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
const DEFAULT_HUGGINGFACE_IMAGE_MODEL = process.env.HUGGINGFACE_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
const DEFAULT_DASHSCOPE_IMAGE_MODEL = process.env.DASHSCOPE_IMAGE_MODEL || "qwen-image-2.0-pro";
const DEFAULT_DASHSCOPE_BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/api/v1";
const DEFAULT_POLLINATIONS_BASE_URL = process.env.POLLINATIONS_BASE_URL || "https://image.pollinations.ai";
const DEFAULT_POLLINATIONS_IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "flux";
const DEFAULT_POLLINATIONS_TIMEOUT_MS = Number(process.env.POLLINATIONS_TIMEOUT_MS || 60000);
const DEFAULT_POLLINATIONS_RETRY_ATTEMPTS = Number(process.env.POLLINATIONS_RETRY_ATTEMPTS || 3);
const DEFAULT_POLLINATIONS_RETRY_DELAY_MS = Number(process.env.POLLINATIONS_RETRY_DELAY_MS || 4500);
const CRC32_TABLE = buildCrc32Table();
let ffmpegFilterSupport = null;
let captionRendererSupport = null;

const STEP_DEFS = [
  ["metadata", "Метаданные YouTube"],
  ["download", "Скачивание видео и субтитров"],
  ["analyze", "Поиск фрагментов"],
  ["render", "Рендер вертикальных рилсов"]
];

const jobs = new Map();

function iso() {
  return new Date().toISOString();
}

function makeId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function defaultOptions(input = {}) {
  const count = clampInt(input.count, 1, 6, 3);
  const minDuration = clampInt(input.minDuration, 15, 90, 28);
  const maxDuration = clampInt(input.maxDuration, minDuration + 5, 120, 55);

  return {
    count,
    minDuration,
    maxDuration,
    language: normalizeLanguage(input.language),
    subtitles: input.subtitles !== false,
    uppercaseSubtitles: input.uppercaseSubtitles !== false,
    cropMode: "fit-blur"
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeLanguage(value) {
  const allowed = new Set(["auto", "ru", "uk", "en"]);
  return allowed.has(value) ? value : "auto";
}

function isYoutubeUrl(value) {
  return validateYoutubeUrl(value).ok;
}

function validateYoutubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, "");
    const youtubeHost = parsed.protocol.startsWith("http") && (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtu.be"
    );
    if (!youtubeHost) {
      return { ok: false, error: "Нужна ссылка YouTube или youtu.be" };
    }

    const id = extractYoutubeId(parsed, host);
    if (!id) {
      return { ok: false, error: "Нужна ссылка на конкретное YouTube видео" };
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
      return { ok: false, error: "Ссылка выглядит обрезанной: YouTube ID должен быть 11 символов" };
    }

    return { ok: true, id };
  } catch {
    return { ok: false, error: "Нужна корректная YouTube ссылка" };
  }
}

function extractYoutubeId(parsed, host) {
  if (host === "youtu.be") {
    return parsed.pathname.split("/").filter(Boolean)[0] || "";
  }
  const watchId = parsed.searchParams.get("v");
  if (watchId) return watchId;
  const match = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
  return match?.[1] || "";
}

function createJob(url, options) {
  const id = makeId();
  const dir = path.join(JOBS_DIR, id);
  return {
    id,
    url,
    dir,
    status: "queued",
    createdAt: iso(),
    updatedAt: iso(),
    options,
    steps: STEP_DEFS.map(([stepId, label]) => ({
      id: stepId,
      label,
      status: "pending"
    })),
    logs: [],
    metadata: null,
    source: null,
    transcript: null,
    segments: [],
    outputs: [],
    renderProgress: null,
    error: null
  };
}

function publicJob(job) {
  return {
    ...job,
    outputs: (job.outputs || []).map((output) => {
      const generatedDescription = generateReelDescription(output);
      return {
        ...output,
        description: generatedDescription || output.description || ""
      };
    }),
    dir: job.dir
  };
}

async function saveJob(job) {
  job.updatedAt = iso();
  await fsp.mkdir(job.dir, { recursive: true });
  await fsp.writeFile(path.join(job.dir, "job.json"), JSON.stringify(publicJob(job), null, 2));
}

function log(job, message) {
  const line = `[${new Date().toLocaleTimeString("ru-RU", { hour12: false })}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > MAX_LOGS) {
    job.logs.splice(0, job.logs.length - MAX_LOGS);
  }
}

async function setStep(job, id, status, detail = "") {
  const step = job.steps.find((item) => item.id === id);
  if (step) {
    step.status = status;
    step.detail = detail || step.detail || "";
  }
  await saveJob(job);
}

async function failJob(job, error) {
  job.status = "failed";
  job.error = error instanceof Error ? error.message : String(error);
  for (const step of job.steps) {
    if (step.status === "running") step.status = "failed";
  }
  log(job, `Ошибка: ${job.error}`);
  await saveJob(job);
}

async function completeJob(job) {
  job.status = "done";
  log(job, `Готово: ${job.outputs.length} рилс(а/ов)`);
  await saveJob(job);
  await persistJobSnapshot(job);
}

function buildSubLangs(language) {
  if (language === "ru") return "ru.*,ru,en.*,en";
  if (language === "uk") return "uk.*,uk,ru.*,ru,en.*,en";
  if (language === "en") return "en.*,en";
  return "ru.*,ru,uk.*,uk,en.*,en";
}

function buildSubtitleLanguageAttempts(language) {
  if (language === "ru") return ["ru.*,ru", "en.*,en"];
  if (language === "uk") return ["uk.*,uk", "ru.*,ru", "en.*,en"];
  if (language === "en") return ["en.*,en"];
  return ["ru.*,ru", "uk.*,uk", "en.*,en"];
}

async function runJob(job) {
  try {
    job.status = "running";
    await saveJob(job);

    await setStep(job, "metadata", "running");
    log(job, "Читаю метаданные YouTube");
    const metadataRaw = await runCommand("yt-dlp", [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      job.url
    ], { cwd: job.dir, logStdout: false }, job);
    const metadata = JSON.parse(metadataRaw);
    job.metadata = {
      title: metadata.title || "YouTube video",
      uploader: metadata.uploader || metadata.channel || "",
      duration: Number(metadata.duration || 0),
      webpage_url: metadata.webpage_url || job.url,
      thumbnail: metadata.thumbnail || "",
      view_count: metadata.view_count || null
    };
    await fsp.writeFile(path.join(job.dir, "metadata.json"), JSON.stringify(metadata, null, 2));
    log(job, `Видео: ${job.metadata.title}`);
    await setStep(job, "metadata", "done");

    await setStep(job, "download", "running");
    log(job, "Скачиваю видео");
    await runCommand("yt-dlp", [
      "--no-playlist",
      "--no-progress",
      "--no-write-subs",
      "--no-write-auto-subs",
      "--merge-output-format",
      "mp4",
      "-f",
      "bv*[height<=720]+ba/best[height<=720]/bv*+ba/best",
      "-o",
      "source.%(ext)s",
      job.url
    ], { cwd: job.dir }, job);

    const mediaFile = await findMediaFile(job.dir);
    if (!mediaFile) {
      throw new Error("yt-dlp не вернул видеофайл");
    }

    const probe = await ffprobe(mediaFile, job.dir);
    job.source = {
      file: mediaFile,
      duration: probe.duration,
      width: probe.width,
      height: probe.height
    };
    log(job, `Источник: ${mediaFile}, ${Math.round(probe.duration)} сек, ${probe.width}x${probe.height}`);

    await downloadCaptionsBestEffort(job);
    await setStep(job, "download", "done");

    await setStep(job, "analyze", "running");
    const captionFile = await findCaptionFile(job.dir, job.options.language);
    let cues = [];
    if (captionFile) {
      cues = await parseCaptionFile(path.join(job.dir, captionFile));
      cues = compactCues(cues);
      job.transcript = {
        file: captionFile,
        cues: cues.length
      };
      log(job, `Найден транскрипт: ${captionFile}, ${cues.length} реплик`);
    } else {
      job.transcript = {
        file: null,
        cues: 0
      };
      log(job, "Субтитры не найдены, делаю нарезку по таймингу без текста");
    }

    job.segments = chooseSegments(cues, probe.duration, job.options);
    await fsp.writeFile(path.join(job.dir, "segments.json"), JSON.stringify(job.segments, null, 2));
    log(job, `Выбрано сегментов: ${job.segments.length}`);
    await setStep(job, "analyze", "done");

    await setStep(job, "render", "running");
    const filters = await getFfmpegFilterSupport().catch(() => ({ subtitles: false, drawtext: false }));
    const captionRenderer = await getCaptionRendererSupport().catch((error) => ({ ok: false, error: error.message }));
    const canRenderImageCaptions = job.options.subtitles && cues.length > 0 && captionRenderer.ok;
    const canBurnSubtitles = job.options.subtitles && cues.length > 0 && !canRenderImageCaptions && filters.subtitles;
    job.render = {
      subtitleMode: canRenderImageCaptions ? "trendy-image-overlays" : (canBurnSubtitles ? "ffmpeg-subtitles" : "none"),
      subtitleBurn: canRenderImageCaptions || canBurnSubtitles,
      ffmpegFilters: filters,
      captionRenderer
    };
    if (canRenderImageCaptions) {
      log(job, "Субтитры: трендовые PNG-оверлеи через Pillow");
    } else if (canBurnSubtitles) {
      log(job, "Субтитры: стандартный ffmpeg subtitles/libass");
    } else if (job.options.subtitles && cues.length > 0) {
      log(job, "Субтитры не будут сожжены: нет Pillow-рендера и фильтра subtitles/libass");
    }

    const outputDir = path.join(job.dir, "outputs");
    await fsp.mkdir(outputDir, { recursive: true });
    for (let index = 0; index < job.segments.length; index += 1) {
      const segment = job.segments[index];
      const outputName = `reel-${index + 1}.mp4`;
      const srtName = `reel-${index + 1}.srt`;
      const outputPath = path.join("outputs", outputName);
      const absoluteOutput = path.join(job.dir, outputPath);
      let captionOverlays = [];

      if (canRenderImageCaptions) {
        captionOverlays = await buildTrendyCaptionAssets({
          job,
          segment,
          cues,
          options: job.options,
          reelIndex: index
        });
      } else if (canBurnSubtitles) {
        const srt = buildSrtForSegment(segment, cues, job.options);
        await fsp.writeFile(path.join(job.dir, srtName), srt || "");
      }

      log(job, `Рендерю ${outputName}: ${formatClock(segment.start)}-${formatClock(segment.end)}`);
      job.renderProgress = {
        reel: index + 1,
        total: job.segments.length,
        file: outputName,
        status: "starting",
        percent: 0,
        outTime: "0:00",
        speed: ""
      };
      await renderSegment({
        job,
        input: mediaFile,
        output: absoluteOutput,
        srtName: canBurnSubtitles ? srtName : null,
        captionOverlays,
        segment,
        index,
        outputName,
        reelNumber: index + 1,
        reelTotal: job.segments.length
      });
      job.renderProgress = {
        reel: index + 1,
        total: job.segments.length,
        file: outputName,
        status: "done",
        percent: 100,
        outTime: formatClock(segment.duration),
        speed: ""
      };

      const outputItem = {
        label: `Reel ${index + 1}`,
        file: `/jobs/${job.id}/${outputPath}`,
        localFile: `/jobs/${job.id}/${outputPath}`,
        start: segment.start,
        end: segment.end,
        duration: segment.duration,
        score: segment.score,
        reason: segment.reason,
        captions: captionOverlays.length,
        text: segment.text,
        description: generateReelDescription({ text: segment.text })
      };
      job.outputs.push(outputItem);
      await persistJobAsset(job, outputItem, {
        localPath: absoluteOutput,
        kind: "reel",
        resourceType: "video",
        mimeType: "video/mp4",
        publicId: `${CLOUDINARY_FOLDER}/${job.id}/outputs/reel-${index + 1}`,
        logLabel: `MP4 Reel ${index + 1}`
      });
      await saveJob(job);
    }
    await setStep(job, "render", "done");
    await completeJob(job);
  } catch (error) {
    await failJob(job, error);
  }
}

async function downloadCaptionsBestEffort(job) {
  log(job, "Пробую скачать субтитры для анализа");
  const attempts = buildSubtitleLanguageAttempts(job.options.language);

  for (const subLangs of attempts) {
    const before = await listCaptionFiles(job.dir);
    try {
      await runCommand("yt-dlp", [
        "--no-playlist",
        "--no-progress",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        subLangs,
        "--sub-format",
        "json3/vtt/best",
        "-o",
        "source.%(ext)s",
        job.url
      ], { cwd: job.dir }, job);
    } catch (error) {
      log(job, `Субтитры ${subLangs} не скачались: ${shortError(error)}`);
    }

    const after = await listCaptionFiles(job.dir);
    const added = after.filter((file) => !before.includes(file));
    if (added.length > 0 || after.length > 0) {
      log(job, `Субтитры доступны: ${(added.length ? added : after).join(", ")}`);
      return;
    }
  }

  log(job, "YouTube captions сейчас недоступны, продолжу без транскрипта");
}

async function findMediaFile(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".part")) continue;
    if (!/\.(mp4|mkv|mov|webm|m4v)$/i.test(entry.name)) continue;
    const stat = await fsp.stat(path.join(dir, entry.name));
    candidates.push({ name: entry.name, size: stat.size });
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0]?.name || null;
}

async function findCaptionFile(dir, language) {
  const captions = await listCaptionFiles(dir);

  if (captions.length === 0) return null;

  const preferred = language === "auto"
    ? ["ru", "uk", "en"]
    : [language, "ru", "uk", "en"];

  captions.sort((a, b) => {
    const aScore = captionPreferenceScore(a, preferred);
    const bScore = captionPreferenceScore(b, preferred);
    if (aScore !== bScore) return aScore - bScore;
    if (a.endsWith(".json3") && b.endsWith(".vtt")) return -1;
    if (a.endsWith(".vtt") && b.endsWith(".json3")) return 1;
    return a.localeCompare(b);
  });

  return captions[0];
}

async function listCaptionFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(json3|vtt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function captionPreferenceScore(filename, preferred) {
  const lower = filename.toLowerCase();
  for (let index = 0; index < preferred.length; index += 1) {
    const lang = preferred[index].toLowerCase();
    if (lower.includes(`.${lang}.`) || lower.includes(`.${lang}-`) || lower.includes(`.${lang}_`)) {
      return index;
    }
  }
  return 99;
}

async function parseCaptionFile(file) {
  if (file.endsWith(".json3")) {
    return parseJson3(await fsp.readFile(file, "utf8"));
  }
  return parseVtt(await fsp.readFile(file, "utf8"));
}

function parseJson3(raw) {
  const data = JSON.parse(raw);
  const cues = [];

  for (const event of data.events || []) {
    if (!event.segs || event.segs.length === 0) continue;
    const start = Number(event.tStartMs || 0) / 1000;
    const duration = Number(event.dDurationMs || 0) / 1000;
    const text = cleanCaptionText(event.segs.map((seg) => seg.utf8 || "").join(""));
    if (!text || text === "\n") continue;
    cues.push({
      start,
      end: Math.max(start + 0.5, start + duration),
      text
    });
  }

  return cues.sort((a, b) => a.start - b.start);
}

function parseVtt(raw) {
  const cues = [];
  const blocks = raw.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;
    const match = lines[timingIndex].match(/([\d:.]+)\s+-->\s+([\d:.]+)/);
    if (!match) continue;
    const text = cleanCaptionText(lines.slice(timingIndex + 1).join(" "));
    if (!text) continue;
    cues.push({
      start: parseTimestamp(match[1]),
      end: parseTimestamp(match[2]),
      text
    });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function cleanCaptionText(value) {
  return decodeEntities(String(value || ""))
    .replace(/<\d{1,2}:\d{2}:\d{2}\.\d{3}>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function compactCues(cues) {
  const result = [];
  let previousNorm = "";
  for (const cue of cues) {
    const norm = cue.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!norm) continue;
    if (norm === previousNorm) continue;
    result.push(cue);
    previousNorm = norm;
  }
  return result;
}

function chooseSegments(cues, duration, options) {
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = Math.max(...cues.map((cue) => cue.end), options.maxDuration * options.count);
  }

  if (cues.length < 4) {
    return fallbackSegments(duration, options);
  }

  const target = Math.round((options.minDuration + options.maxDuration) / 2);
  const hardMaxDuration = Math.min(120, Math.max(options.maxDuration + 48, Math.round(options.maxDuration * 1.7)));
  const candidates = [];

  for (let i = 0; i < cues.length; i += 1) {
    const startQuality = scoreStartBoundary(cues, i);
    if (isBadStartCue(cues[i].text) && startQuality < 2.5) continue;

    const start = Math.max(0, cues[i].start - 0.8);
    const textParts = [];

    for (let j = i; j < cues.length; j += 1) {
      textParts.push(cues[j].text);
      const end = Math.min(duration, cues[j].end + 0.45);
      const windowDuration = end - start;
      if (windowDuration < options.minDuration) continue;
      if (windowDuration > hardMaxDuration) break;

      const endQuality = scoreEndBoundary(cues, j, duration);
      const closureData = scoreSemanticClosure(textParts.join(" "), cues, j, duration);
      const enoughClosure = closureData.score >= 3.5 && !closureData.needsContinuation;
      if (closureData.dangling || closureData.cliffhanger) continue;
      if (!enoughClosure && windowDuration < hardMaxDuration - 1) continue;

      const text = textParts.join(" ");
      const scoreData = scoreStorySegment({
        text,
        windowDuration,
        start,
        totalDuration: duration,
        target,
        startQuality,
        endQuality,
        startCue: cues[i],
        endCue: cues[j],
        nextCue: cues[j + 1] || null,
        closureData,
        softMaxDuration: options.maxDuration
      });
      const candidate = {
        start,
        end,
        duration: windowDuration,
        text: collapseWords(text, 120),
        score: scoreData.score,
        reason: buildStoryReason(scoreData)
      };

      candidates.push(candidate);

      if (windowDuration >= target && endQuality >= 4 && closureData.score >= 6) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= options.count) break;
    const overlaps = selected.some((item) => overlapRatio(item, candidate) > 0.25);
    if (!overlaps) {
      selected.push(candidate);
    }
  }

  if (selected.length === 0) {
    return fallbackSegments(duration, options);
  }

  return selected.map((segment, index) => ({
    ...addEndReactionTail(segment, duration),
    rank: index + 1,
    score: round2(segment.score)
  }));
}

function addEndReactionTail(segment, totalDuration) {
  const start = Number(segment.start) || 0;
  const originalEnd = Number(segment.end) || start;
  const safeTotal = Number.isFinite(totalDuration) && totalDuration > 0
    ? totalDuration
    : originalEnd + END_REACTION_TAIL_SECONDS;
  const end = Math.min(safeTotal, originalEnd + END_REACTION_TAIL_SECONDS);

  return {
    ...segment,
    start: round2(start),
    end: round2(end),
    duration: round2(end - start)
  };
}

function fallbackSegments(duration, options) {
  const clipDuration = Math.min(options.maxDuration, Math.max(options.minDuration, 35));
  const safeDuration = Math.max(duration || clipDuration, clipDuration);
  const gap = Math.max(8, clipDuration * 0.4);
  const segments = [];

  for (let index = 0; index < options.count; index += 1) {
    const start = Math.min(Math.max(0, index * (clipDuration + gap)), Math.max(0, safeDuration - clipDuration));
    const end = Math.min(safeDuration, start + clipDuration + END_REACTION_TAIL_SECONDS);
    segments.push({
      rank: index + 1,
      start: round2(start),
      end: round2(end),
      duration: round2(end - start),
      score: 0,
      reason: "нет транскрипта, равномерная нарезка",
      text: ""
    });
    if (end >= safeDuration) break;
  }

  return segments;
}

function scoreStartBoundary(cues, index) {
  const cue = cues[index];
  const previous = cues[index - 1] || null;
  const gap = previous ? cue.start - previous.end : 99;
  let score = 0;

  if (gap >= 0.75) score += 3.2;
  else if (gap >= 0.35) score += 1.4;
  if (startsNewThought(cue.text)) score += 3.4;
  if (hasHookSignal(cue.text)) score += 1.6;
  if (!isBadStartCue(cue.text)) score += 1.1;
  if (previous && endsWithSentencePunctuation(previous.text)) score += 1.1;

  return score;
}

function scoreEndBoundary(cues, index, totalDuration) {
  const cue = cues[index];
  const next = cues[index + 1] || null;
  const gap = next ? next.start - cue.end : 99;
  let score = 0;

  if (endsWithSentencePunctuation(cue.text)) score += 4.2;
  if (gap >= 0.75) score += 3.1;
  else if (gap >= 0.35) score += 1.3;
  if (!next || startsNewThought(next.text)) score += 1.8;
  if (hasPayoffSignal(cue.text)) score += 3.2;
  if (cue.end > totalDuration - 1) score += 1.2;
  if (isBadEndCue(cue.text)) score -= 4.5;

  return score;
}

function startsNewThought(text) {
  const lower = normalizeText(text);
  return /^(смотрите|послушайте|слушайте|запомните|представьте|знаете|важно|главное|вот|однажды|когда|почему|как|давайте|сегодня|есть|псалом|библия|бог|господь|иисус|я хочу|мы видим|я сказал|он сказал|она сказала|look|listen|remember|imagine|why|how|today|when|there is)(?:\s|$)/.test(lower);
}

function hasHookSignal(text) {
  const lower = normalizeText(text);
  return /(\?|почему|как|секрет|ошибка|никогда|всегда|важно|главное|смотрите|послушайте|запомните|why|how|secret|mistake|never|always|important|watch|listen|remember)/.test(lower);
}

function hasPayoffSignal(text) {
  const lower = normalizeText(text);
  return /(?:вот почему|that is why|(?:^|\s)(?:поэтому|значит|получается|запомните|главное|сегодня|итак|аминь|ответ|решение|решением|помощь|чудо|обещание|therefore|remember|answer|solution|promise)(?:\s|$))/.test(lower);
}

function isBadStartCue(text) {
  return /^(и|а|потому|потому что|что|чтобы|котор|когда это|или|то есть|так что)(?:\s|$)/i.test(normalizeText(text));
}

function isBadEndCue(text) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] || "";
  return /^(и|а|но|что|чтобы|как|если|бы|в|во|на|с|со|по|к|ко|из|за|для|об|о|у|ты|вы|я|мы|он|она|они|это|этот|эта|свой|своей|очень|один|одного|никогда|сказал|сказала|говорит|видел|увидел|смотрел|спросил|ответил|который|которая|которые|потому|or|and|but|that|to|of|in|on|with|if|you|we|i|he|she|they|very|never|said|saw|asked)$/.test(last);
}

function endsWithSentencePunctuation(text) {
  return /[.!?…]["')\]]?$/.test(String(text || "").trim());
}

function scoreSemanticClosure(text, cues, index, totalDuration) {
  const cue = cues[index];
  const next = cues[index + 1] || null;
  const lower = normalizeText(text);
  const tail = tailWords(lower, 24);
  const closureTail = tailWords(lower, 10);
  let score = 0;
  const dangling = isBadEndCue(cue.text) || hasDanglingTail(tail);
  const cliffhanger = hasCliffhangerTail(tail);
  const nextPullsForward = nextContinuesThought(next?.text || "");
  const rollingCaptionContinues = Boolean(next) &&
    next.start < cue.end + 0.35 &&
    !endsWithSentencePunctuation(cue.text) &&
    !hasClosurePhrase(closureTail) &&
    !hasPayoffSignal(closureTail);

  if (endsWithSentencePunctuation(cue.text)) score += 4;
  if (hasPayoffSignal(closureTail)) score += 3.5;
  if (hasClosurePhrase(closureTail)) score += 4;
  if (next && startsNewThought(next.text) && !nextPullsForward) score += 2.2;
  if (!next || cue.end > totalDuration - 1) score += 2;
  if (!dangling) score += 1.5;

  if (dangling) score -= 6;
  if (cliffhanger) score -= 7;
  if (nextPullsForward) score -= 4;
  if (rollingCaptionContinues) score -= 2.5;

  return {
    score,
    dangling,
    cliffhanger,
    needsContinuation: dangling || cliffhanger || nextPullsForward || rollingCaptionContinues,
    hasClosure: hasClosurePhrase(closureTail) || hasPayoffSignal(closureTail)
  };
}

function hasDanglingTail(tail) {
  return /(?:^|\s)(?:и|а|но|что|чтобы|как|если|бы|в|во|на|с|со|по|к|ко|из|за|для|об|о|у|ты|вы|я|мы|он|она|они|это|этот|эта|свой|своей|очень|один|одного|никогда|сказал|сказала|говорит|видел|увидел|смотрел|спросил|ответил|который|которая|которые)\s*$/.test(tail);
}

function hasCliffhangerTail(tail) {
  return /(я хочу (?:вам )?сказать почему|могу ли я (?:вам )?что-то сказать|вот мой вопрос|что случилось потом|дело в том|сейчас скажу|вопрос если|если .* кто|почему я тут|боялась спросить|мне нужно .*автобус.*водител[а-я]*|вы можете дать .*водител[а-я]*|поэтому библия|лидия никогда|никого не видел|why i|let me tell you why|my question is|what happened next)$/.test(tail);
}

function nextContinuesThought(text) {
  const lower = normalizeText(text);
  return /^(но|и|а|если|потом|затем|тогда|поэтому|вот|он сказал|она сказала|я сказал|говорит|but|and|if|then|so|therefore)(?:\s|$)/.test(lower);
}

function hasClosurePhrase(tail) {
  return /(вот почему|и это|поэтому|на этом|сегодня|аминь|вот ответ|в этом смысл|вот что произошло|мы подождем|не уходите|один автобус|одного водителя|дал автобус|дам .*автобус|божьей помощью|that is why|this is why|therefore|that is the point|this is the point|we will wait)$/.test(tail);
}

function tailWords(text, count) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  return words.slice(-count).join(" ");
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”„"']/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

function scoreStorySegment({
  text,
  windowDuration,
  start,
  totalDuration,
  target,
  startQuality,
  endQuality,
  startCue,
  endCue,
  nextCue,
  closureData,
  softMaxDuration
}) {
  const words = text.split(/\s+/).filter(Boolean);
  const lower = normalizeText(text);
  const setup = keywordHits(lower, [
    "почему", "как", "вопрос", "проблем", "нужн", "нужда", "идея", "псалом", "обещание", "вера",
    "страх", "боль", "сложно", "кризис", "why", "how", "question", "problem", "need", "faith"
  ]);
  const turn = keywordHits(lower, [
    "но", "однако", "тогда", "потом", "и вот", "вдруг", "после этого", "я сказал", "он сказал",
    "она сказала", "говорит", "спросил", "ответил", "приходит", "подошел", "позвонила",
    "but", "then", "suddenly", "said", "asked", "answered"
  ]);
  const payoff = keywordHits(lower, [
    "поэтому", "вот почему", "значит", "получается", "решение", "ответ", "никогда", "сегодня",
    "запомните", "главное", "бог", "господь", "помощь", "чудо", "обещание", "аминь",
    "therefore", "that is why", "solution", "answer", "remember", "never", "promise"
  ]);
  const outcome = keywordHits(lower, [
    "я тебе дам", "я дам", "он так сделал", "в итоге", "в результате", "получилось", "теперь есть",
    "автобус", "водителя", "сделаю", "обещать", "i will give", "i gave", "he did", "as a result"
  ]);
  const dialogue = keywordHits(lower, ["сказал", "сказала", "говорит", "спросил", "ответил", "asked", "said", "answered"]);
  const emotion = keywordHits(lower, ["сильн", "страшн", "радост", "слез", "сердц", "вер", "любов", "fear", "heart", "love"]);
  const hasSetup = setup > 0 || hasHookSignal(startCue.text);
  const hasTurn = turn > 0 || dialogue > 1;
  const hasPayoff = payoff > 0 || outcome > 0 || hasPayoffSignal(endCue.text);
  const arcScore = (hasSetup && hasTurn && hasPayoff)
    ? 16
    : (hasSetup && hasPayoff)
      ? 10
      : (hasTurn && hasPayoff)
        ? 8
        : (hasSetup || hasTurn || hasPayoff)
          ? 3.5
          : 0;
  const density = words.length / Math.max(1, windowDuration);
  const durationScore = Math.max(0, 8 - Math.abs(windowDuration - target) * 0.22);
  const boundaryScore = startQuality * 1.15 + endQuality * 1.35;
  const punctuationScore = (text.match(/[?!]/g) || []).length * 1.6;
  const numberScore = (text.match(/\d+/g) || []).length * 0.65;
  const earlySignal = totalDuration > 0 && start < totalDuration * 0.25 ? 1.2 : 0;
  const badStartPenalty = isBadStartCue(startCue.text) ? 5.5 : 0;
  const badEndPenalty = isBadEndCue(endCue.text) ? 6 : 0;
  const danglingPenalty = nextCue && !endsWithSentencePunctuation(endCue.text) && scoreEndBoundary([endCue, nextCue], 0, totalDuration) < 2 ? 2.5 : 0;
  const continuationPenalty = closureData.needsContinuation ? 10 : 0;
  const closureScore = Math.max(-6, Math.min(8, closureData.score));
  const overSoftMaxPenalty = Math.max(0, windowDuration - softMaxDuration) * 0.16;

  return {
    score: density * 2.1 +
      setup * 2.1 +
      turn * 2.3 +
      payoff * 3 +
      outcome * 3.2 +
      dialogue * 1.15 +
      emotion * 0.9 +
      arcScore +
      durationScore +
      boundaryScore +
      punctuationScore +
      numberScore +
      closureScore +
      earlySignal -
      badStartPenalty -
      badEndPenalty -
      danglingPenalty -
      continuationPenalty -
      overSoftMaxPenalty,
    hasSetup,
    hasTurn,
    hasPayoff,
    hasClosure: closureData.hasClosure,
    startQuality,
    endQuality
  };
}

function keywordHits(text, keywords) {
  return keywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
}

function buildStoryReason(scoreData) {
  const parts = [];
  if (scoreData.hasSetup) parts.push("крючок");
  if (scoreData.hasTurn) parts.push("поворот");
  if (scoreData.hasPayoff) parts.push("вывод");
  if (scoreData.hasClosure) parts.push("закрытая мысль");
  if (scoreData.endQuality >= 5) parts.push("естественная концовка");
  if (parts.length === 0) return "story-aware: цельный фрагмент речи";
  return `story-aware: ${parts.join(" + ")}`;
}

function collapseWords(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  const headCount = Math.max(24, Math.round(maxWords * 0.68));
  const tailCount = Math.max(12, maxWords - headCount);
  return `${words.slice(0, headCount).join(" ")} ... ${words.slice(-tailCount).join(" ")}`;
}

function overlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap / Math.max(1, Math.min(a.duration, b.duration));
}

function buildSrtForSegment(segment, cues, options) {
  const overlapping = cues.filter((cue) => cue.end > segment.start && cue.start < segment.end);
  const subtitleCues = [];

  for (const cue of overlapping) {
    const start = Math.max(0, cue.start - segment.start);
    const end = Math.min(segment.duration, cue.end - segment.start);
    const duration = Math.max(0.6, end - start);
    const words = cue.text.split(/\s+/).filter(Boolean);
    const chunks = chunkWords(words, 4);
    if (chunks.length === 0) continue;
    chunks.forEach((chunk, index) => {
      const chunkStart = start + (duration / chunks.length) * index;
      const chunkEnd = start + (duration / chunks.length) * (index + 1);
      let text = chunk.join(" ");
      if (options.uppercaseSubtitles) text = text.toLocaleUpperCase("ru-RU");
      subtitleCues.push({
        start: chunkStart,
        end: Math.min(segment.duration, chunkEnd),
        text
      });
    });
  }

  return subtitleCues
    .filter((cue) => cue.end - cue.start >= 0.2)
    .map((cue, index) => [
      String(index + 1),
      `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`,
      wrapSubtitle(cue.text),
      ""
    ].join("\n"))
    .join("\n");
}

async function buildTrendyCaptionAssets({ job, segment, cues, options, reelIndex }) {
  const chunks = buildTrendyCaptionChunks(segment, cues, options);
  if (chunks.length === 0) return [];

  const captionRoot = path.join(job.dir, "captions", `reel-${reelIndex + 1}`);
  await fsp.mkdir(captionRoot, { recursive: true });
  const planPath = path.join(captionRoot, "captions.json");
  await fsp.writeFile(planPath, JSON.stringify({
    width: 1080,
    height: 1920,
    chunks
  }, null, 2));

  await runCommand("python3", [
    path.join(ROOT, "scripts", "render_trendy_captions.py"),
    planPath,
    captionRoot
  ], { cwd: ROOT, logStdout: false }, job);

  return chunks.map((chunk, index) => ({
    ...chunk,
    file: path.join(captionRoot, `cap_${String(index).padStart(3, "0")}.png`)
  }));
}

function buildTrendyCaptionChunks(segment, cues, options) {
  const overlapping = cues.filter((cue) => cue.end > segment.start && cue.start < segment.end);
  const rawChunks = [];
  const captionLead = 0.1;

  for (const cue of overlapping) {
    const localStart = Math.max(0, cue.start - segment.start);
    const localEnd = Math.min(segment.duration, cue.end - segment.start);
    const duration = Math.max(0.35, localEnd - localStart);
    const words = cue.text
      .split(/\s+/)
      .map(cleanCaptionWord)
      .filter(Boolean);
    if (words.length === 0) continue;

    let wordOffset = 0;
    for (const group of groupWordsForCaptionCue(words)) {
      const rawStart = localStart + duration * (wordOffset / words.length);
      const rawEnd = localStart + duration * ((wordOffset + group.length) / words.length);
      wordOffset += group.length;
      let text = group.join(" ");
      if (options.uppercaseSubtitles) text = text.toLocaleUpperCase("ru-RU");
      rawChunks.push({
        start: Math.max(0, rawStart - captionLead),
        end: Math.min(segment.duration, rawEnd),
        text,
        emphasisIndex: chooseEmphasisIndex(group)
      });
    }
  }

  const chunks = [];
  rawChunks.sort((a, b) => a.start - b.start);
  for (let index = 0; index < rawChunks.length; index += 1) {
    const chunk = rawChunks[index];
    const next = rawChunks[index + 1] || null;
    const start = round2(chunk.start);
    let end = Math.max(chunk.end, chunk.start + 0.65);
    if (next && end > next.start - 0.04) {
      end = next.start - 0.04;
    }
    end = round2(Math.min(segment.duration, end));
    if (end - start < 0.25) continue;

    chunks.push({
      start,
      end,
      duration: round2(end - start),
      text: chunk.text,
      emphasisIndex: chunk.emphasisIndex
    });
  }

  return chunks
    .slice(0, 90)
    .map((chunk) => ({
      ...chunk,
      duration: round2(chunk.end - chunk.start)
    }));
}

function groupWordsForCaptionCue(words) {
  const groups = [];
  let index = 0;
  while (index < words.length) {
    const remaining = words.length - index;
    const size = remaining <= 7 ? remaining : 6;
    groups.push(words.slice(index, index + size));
    index += size;
  }
  return groups;
}

function groupCaptionWordItems(items) {
  const groups = [];
  let index = 0;

  while (index < items.length) {
    const group = [items[index]];
    let end = items[index].end;
    index += 1;

    while (index < items.length && group.length < 4) {
      const next = items[index];
      const gap = next.start - end;
      const projectedDuration = next.end - group[0].start;
      const shouldStop = gap > 0.3 ||
        projectedDuration > 2.25 ||
        (group.length >= 2 && /[.!?…]$/.test(group[group.length - 1].word));
      if (shouldStop) break;
      group.push(next);
      end = next.end;
      index += 1;
    }

    if (group.length === 1 && index < items.length) {
      const next = items[index];
      if (next.start - group[0].end <= 0.45 && next.end - group[0].start <= 2.5) {
        group.push(next);
        index += 1;
      }
    }

    groups.push(group);
  }

  return groups;
}

function cleanCaptionWord(word) {
  return String(word || "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}!?.,:;-]+$/gu, "")
    .trim();
}

function groupCaptionWords(words) {
  const groups = [];
  let index = 0;
  while (index < words.length) {
    const remaining = words.length - index;
    const first = words[index] || "";
    const size = remaining <= 4
      ? remaining
      : (first.length >= 10 ? 2 : 3);
    groups.push(words.slice(index, index + Math.max(1, Math.min(4, size))));
    index += size;
  }
  return groups;
}

function mergeCaptionChunks(chunks) {
  const result = [];
  for (const chunk of chunks) {
    const previous = result[result.length - 1];
    if (previous && chunk.start < previous.end - 0.04) {
      previous.end = round2(Math.min(previous.end, Math.max(previous.start + 0.25, chunk.start - 0.03)));
      if (previous.end - previous.start < 0.25) result.pop();
    }
    result.push(chunk);
  }
  return result.filter((chunk) => chunk.end - chunk.start >= 0.25);
}

function chooseEmphasisIndex(words) {
  let bestIndex = Math.max(0, words.length - 1);
  let bestScore = -Infinity;
  words.forEach((word, index) => {
    const clean = normalizeText(word).replace(/[^\p{L}\p{N}]+/gu, "");
    const score = clean.length +
      (hasHookSignal(clean) ? 6 : 0) +
      (hasPayoffSignal(clean) ? 7 : 0) +
      (/\d/.test(clean) ? 4 : 0) +
      index * 0.2;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function chunkWords(words, size) {
  const chunks = [];
  for (let index = 0; index < words.length; index += size) {
    chunks.push(words.slice(index, index + size));
  }
  return chunks;
}

function wrapSubtitle(text) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 26 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 2).join("\n");
}

function createFfmpegProgressHandler(job, { duration, outputName, reelNumber, reelTotal }) {
  const state = {};
  let nextLogPercent = 10;
  let loggedDone = false;

  return (line) => {
    const match = String(line || "").trim().match(/^([^=]+)=(.*)$/);
    if (!match) return;

    const [, key, value] = match;
    state[key] = value;

    if (!["frame", "fps", "speed", "out_time", "out_time_us", "out_time_ms", "progress"].includes(key)) {
      return;
    }

    const done = key === "progress" && value === "end";
    const seconds = done ? duration : readFfmpegProgressSeconds(state);
    const rawPercent = duration > 0 ? (seconds / duration) * 100 : 0;
    const percent = done ? 100 : Math.min(99.5, Math.max(0, rawPercent));
    const speed = state.speed && state.speed !== "N/A" ? state.speed.trim() : "";

    job.renderProgress = {
      reel: reelNumber,
      total: reelTotal,
      file: outputName,
      status: done ? "done" : "running",
      percent: round2(percent),
      outTime: formatClock(seconds),
      duration: formatClock(duration),
      frame: state.frame || "",
      fps: state.fps || "",
      speed
    };

    if (!done && percent >= nextLogPercent) {
      log(job, `${outputName}: ${Math.floor(percent)}% (${formatClock(seconds)} / ${formatClock(duration)}${speed ? `, ${speed}` : ""})`);
      nextLogPercent += 10;
    }

    if (done && !loggedDone) {
      log(job, `${outputName}: 100% (${formatClock(duration)})`);
      loggedDone = true;
    }
  };
}

function readFfmpegProgressSeconds(state) {
  for (const key of ["out_time_us", "out_time_ms"]) {
    const microseconds = Number(state[key]);
    if (Number.isFinite(microseconds) && microseconds > 0) {
      return microseconds / 1000000;
    }
  }
  if (state.out_time && state.out_time !== "N/A") {
    return parseTimestamp(state.out_time);
  }
  return 0;
}

async function renderSegment({ job, input, output, srtName, captionOverlays = [], segment, outputName = "reel.mp4", reelNumber = 1, reelTotal = 1 }) {
  const duration = Math.max(0.1, segment.end - segment.start);
  const onStdoutLine = createFfmpegProgressHandler(job, {
    duration,
    outputName,
    reelNumber,
    reelTotal
  });
  const subtitleFilter = srtName
    ? `,subtitles=filename='${srtName}':force_style='FontName=Helvetica,FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=165'`
    : "";
  const inputArgs = [
    "-ss",
    String(segment.start),
    "-t",
    String(duration),
    "-i",
    input
  ];
  for (const caption of captionOverlays) {
    inputArgs.push(
      "-loop",
      "1",
      "-t",
      String(Math.max(0.3, caption.end - caption.start + 0.12)),
      "-i",
      caption.file
    );
  }

  const baseLabel = captionOverlays.length > 0 ? "base" : "v";
  const filterParts = [
    "[0:v]split=2[v0][v1]",
    "[v0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:1,eq=brightness=-0.07:saturation=0.85[bg]",
    "[v1]scale=1080:1920:force_original_aspect_ratio=decrease[fg]",
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1${subtitleFilter}[${baseLabel}]`
  ];

  let currentLabel = baseLabel;
  captionOverlays.forEach((caption, index) => {
    const inputIndex = index + 1;
    const captionLabel = `cap${index}`;
    const nextLabel = index === captionOverlays.length - 1 ? "v" : `vo${index}`;
    const start = Math.max(0, caption.start).toFixed(3);
    const end = Math.min(duration, caption.end).toFixed(3);
    const fadeOutStart = Math.max(0, caption.end - caption.start - 0.06).toFixed(3);
    filterParts.push(
      `[${inputIndex}:v]format=rgba,fade=t=in:st=0:d=0.05:alpha=1,fade=t=out:st=${fadeOutStart}:d=0.05:alpha=1,setpts=PTS-STARTPTS+${start}/TB[${captionLabel}]`
    );
    filterParts.push(
      `[${currentLabel}][${captionLabel}]overlay=0:0:eof_action=pass:enable='between(t,${start},${end})'[${nextLabel}]`
    );
    currentLabel = nextLabel;
  });

  const filterComplex = filterParts.join(";");

  const fadeOutStart = Math.max(0, duration - 0.03).toFixed(3);
  await runCommand("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-map",
    "0:a?",
    "-af",
    `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOutStart}:d=0.03`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    output
  ], { cwd: job.dir, logStdout: false, onStdoutLine }, job);
}

async function ffprobe(file, cwd) {
  const raw = await runCommand("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file
  ], { cwd });
  const data = JSON.parse(raw);
  const video = (data.streams || []).find((stream) => stream.codec_type === "video") || {};
  return {
    duration: Number(data.format?.duration || video.duration || 0),
    width: Number(video.width || 0),
    height: Number(video.height || 0)
  };
}

async function getFfmpegFilterSupport() {
  if (ffmpegFilterSupport) return ffmpegFilterSupport;
  const output = await runCommand("ffmpeg", ["-hide_banner", "-filters"], { cwd: ROOT });
  ffmpegFilterSupport = {
    subtitles: /^\s*[TSC.]+\s+(subtitles|ass)\s+/m.test(output),
    drawtext: /^\s*[TSC.]+\s+drawtext\s+/m.test(output)
  };
  return ffmpegFilterSupport;
}

async function getCaptionRendererSupport() {
  if (captionRendererSupport) return captionRendererSupport;
  try {
    const output = await runCommand("python3", [
      "-c",
      "import PIL; print('Pillow ' + PIL.__version__)"
    ], { cwd: ROOT });
    captionRendererSupport = {
      ok: true,
      version: output.split(/\r?\n/)[0] || "Pillow"
    };
  } catch (error) {
    captionRendererSupport = {
      ok: false,
      error: error.message
    };
  }
  return captionRendererSupport;
}

function runCommand(command, args, options = {}, job = null) {
  return new Promise((resolve, reject) => {
    if (job) log(job, `$ ${command} ${args.map(maskArg).join(" ")}`);
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    const emitStdoutLines = (text, flush = false) => {
      if (!options.onStdoutLine) return;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      if (flush) {
        stdoutLineBuffer = "";
      } else {
        stdoutLineBuffer = lines.pop() || "";
      }
      lines.map((line) => line.trim()).filter(Boolean).forEach((line) => {
        try {
          options.onStdoutLine(line);
        } catch (error) {
          if (job) log(job, `Не удалось прочитать progress ffmpeg: ${shortError(error)}`);
        }
      });
    };
    const onData = (chunk, target) => {
      const text = chunk.toString();
      if (target === "stdout") stdout += text;
      if (target === "stderr") stderr += text;
      if (target === "stdout") emitStdoutLines(text);
      const shouldLog = (target !== "stdout" || options.logStdout !== false) &&
        (target !== "stderr" || options.logStderr !== false);
      if (job && shouldLog) {
        text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-20).forEach((line) => {
          log(job, line);
        });
      }
    };

    child.stdout.on("data", (chunk) => onData(chunk, "stdout"));
    child.stderr.on("data", (chunk) => onData(chunk, "stderr"));
    child.on("error", reject);
    child.on("close", (code) => {
      emitStdoutLines("", true);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-1200) || stdout.slice(-1200)}`));
      }
    });
  });
}

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 320);
}

function maskArg(arg) {
  const value = String(arg);
  if (value.length > 180) return `${value.slice(0, 177)}...`;
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function parseTimestamp(value) {
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return Number(value) || 0;
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, "0")}`;
}

function formatClock(seconds) {
  const clamped = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped % 60);
  return `${m}:${pad(s)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders()
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...corsHeaders()
  });
  res.end(text);
}

function sendBuffer(res, status, buffer, headers = {}) {
  res.writeHead(status, {
    "content-length": buffer.length,
    "cache-control": "no-store",
    ...corsHeaders(),
    ...headers
  });
  res.end(buffer);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

async function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === "/" || pathname === "/index.html") {
    filePath = path.join(ROOT, "index.html");
  } else if (pathname.startsWith("/jobs/")) {
    const relative = pathname.replace(/^\/jobs\//, "");
    filePath = path.resolve(JOBS_DIR, relative);
    if (!filePath.startsWith(path.resolve(JOBS_DIR))) {
      sendText(res, 403, "Forbidden");
      return;
    }
  } else {
    sendText(res, 404, "Not found");
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": mimeType(filePath),
      "content-length": stat.size,
      "cache-control": pathname.startsWith("/jobs/") && !pathname.includes("/covers/") ? "public, max-age=3600" : "no-store",
      ...corsHeaders()
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".srt": "text/plain; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function normalizeStorageProvider(value) {
  const provider = String(value || "").toLowerCase().trim();
  if (["auto", "cloudinary", "local", "none", "off"].includes(provider)) {
    return provider === "off" ? "none" : provider;
  }
  return "auto";
}

function sanitizeCloudinaryFolder(value) {
  return String(value || "auto-reels")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("/")
    .slice(0, 120) || "auto-reels";
}

function getCloudinaryConfig() {
  let fromUrl = null;
  const rawUrl = process.env.CLOUDINARY_URL;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "cloudinary:") {
        fromUrl = {
          cloudName: parsed.hostname,
          apiKey: decodeURIComponent(parsed.username || ""),
          apiSecret: decodeURIComponent(parsed.password || "")
        };
      }
    } catch {
      fromUrl = null;
    }
  }

  const config = fromUrl || {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || ""
  };
  if (!config.cloudName || !config.apiKey || !config.apiSecret) return null;
  return config;
}

function getPersistentStorageStatus() {
  const cloudinary = getCloudinaryConfig();
  const provider = STORAGE_PROVIDER === "auto"
    ? (cloudinary ? "cloudinary" : "local")
    : STORAGE_PROVIDER;
  const ok = provider === "cloudinary" ? Boolean(cloudinary) : provider === "local";
  return {
    ok,
    provider,
    folder: provider === "cloudinary" ? CLOUDINARY_FOLDER : "",
    mode: provider === "cloudinary" ? "external-assets" : "render-ephemeral-local",
    configured: provider === "cloudinary" ? Boolean(cloudinary) : provider === "local"
  };
}

function persistentStorageReady() {
  const status = getPersistentStorageStatus();
  return status.ok && status.provider === "cloudinary";
}

async function persistJobAsset(job, asset, options) {
  if (!persistentStorageReady()) return false;
  try {
    const result = await uploadCloudinaryFile(options.localPath, {
      resourceType: options.resourceType,
      mimeType: options.mimeType,
      publicId: options.publicId,
      filename: path.basename(options.localPath)
    });
    asset.file = result.secureUrl;
    asset.storage = {
      provider: "cloudinary",
      kind: options.kind || "asset",
      url: result.secureUrl,
      publicId: result.publicId,
      resourceType: result.resourceType,
      bytes: result.bytes || 0,
      savedAt: iso()
    };
    log(job, `${options.logLabel || "Файл"} сохранен во внешнее хранилище Cloudinary`);
    return true;
  } catch (error) {
    log(job, `${options.logLabel || "Файл"} остался локально: Cloudinary не принял файл (${shortError(error)})`);
    return false;
  }
}

async function persistJobSnapshot(job) {
  if (!persistentStorageReady()) return false;
  try {
    const snapshot = {
      ...publicJob(job),
      dir: "",
      storage: {
        provider: "cloudinary",
        folder: `${CLOUDINARY_FOLDER}/${job.id}`,
        savedAt: iso()
      }
    };
    const result = await uploadCloudinaryBuffer(Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"), {
      resourceType: "raw",
      mimeType: "application/json",
      publicId: `${CLOUDINARY_FOLDER}/${job.id}/job.json`,
      filename: "job.json"
    });
    await updateCloudinaryJobIndex(job, result.secureUrl);
    return true;
  } catch (error) {
    log(job, `Манифест job не сохранился во внешнее хранилище: ${shortError(error)}`);
    return false;
  }
}

async function updateCloudinaryJobIndex(job, manifestUrl) {
  const index = await readCloudinaryJobIndex().catch(() => ({ version: 1, jobs: [] }));
  const maxItems = Math.max(1, Math.min(200, Number(CLOUDINARY_INDEX_LIMIT) || 50));
  const entry = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    title: job.metadata?.title || "",
    uploader: job.metadata?.uploader || "",
    outputs: (job.outputs || []).length,
    manifestUrl,
    webpageUrl: job.metadata?.webpage_url || job.url || ""
  };
  const jobsIndex = Array.isArray(index.jobs) ? index.jobs : [];
  const next = {
    version: 1,
    updatedAt: iso(),
    jobs: [entry, ...jobsIndex.filter((item) => item?.id !== job.id)]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, maxItems)
  };
  await uploadCloudinaryBuffer(Buffer.from(JSON.stringify(next, null, 2), "utf8"), {
    resourceType: "raw",
    mimeType: "application/json",
    publicId: `${CLOUDINARY_FOLDER}/index/jobs.json`,
    filename: "jobs.json"
  });
}

async function readCloudinaryJobIndex() {
  const url = `${cloudinaryDeliveryUrl("raw", `${CLOUDINARY_FOLDER}/index/jobs.json`)}?t=${Date.now()}`;
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: { accept: "application/json" }
  }, 12000);
  if (!response.ok) throw await buildHttpError(response, "Cloudinary job index is unavailable");
  return response.json();
}

async function loadPersistentJobs() {
  if (!persistentStorageReady()) return;
  let index;
  try {
    index = await readCloudinaryJobIndex();
  } catch {
    return;
  }

  const entries = Array.isArray(index.jobs) ? index.jobs.slice(0, Math.max(1, Math.min(200, Number(CLOUDINARY_INDEX_LIMIT) || 50))) : [];
  for (const entry of entries) {
    const manifestUrl = entry?.manifestUrl || cloudinaryDeliveryUrl("raw", `${CLOUDINARY_FOLDER}/${entry?.id || ""}/job.json`);
    if (!entry?.id || !manifestUrl) continue;
    try {
      const response = await fetchWithTimeout(`${manifestUrl}${manifestUrl.includes("?") ? "&" : "?"}t=${Date.now()}`, {
        method: "GET",
        headers: { accept: "application/json" }
      }, 12000);
      if (!response.ok) continue;
      const job = await response.json();
      if (!job?.id) continue;
      job.dir = path.join(JOBS_DIR, job.id);
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        job.error = "Задача была остановлена при завершении сервера";
        for (const step of job.steps || []) {
          if (step.status === "running") step.status = "failed";
        }
      }
      const existing = jobs.get(job.id);
      if (!existing || String(job.updatedAt || "").localeCompare(String(existing.updatedAt || "")) > 0) {
        jobs.set(job.id, job);
      }
    } catch {
      // Ignore broken remote manifests. The local app must still boot.
    }
  }
}

async function uploadCloudinaryFile(filePath, options) {
  const buffer = await fsp.readFile(filePath);
  return uploadCloudinaryBuffer(buffer, options);
}

async function uploadCloudinaryBuffer(buffer, options) {
  const config = getCloudinaryConfig();
  if (!config) throw new Error("CLOUDINARY_URL или CLOUDINARY_* переменные не настроены");
  const resourceType = ["image", "video", "raw"].includes(options.resourceType) ? options.resourceType : "raw";
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    public_id: options.publicId,
    overwrite: "true",
    timestamp: String(timestamp)
  };
  const signature = signCloudinaryParams(params, config.apiSecret);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: options.mimeType || "application/octet-stream" }), options.filename || "asset");
  for (const [key, value] of Object.entries(params)) {
    form.append(key, value);
  }
  form.append("api_key", config.apiKey);
  form.append("signature", signature);

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/${resourceType}/upload`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    body: form
  }, Number(process.env.CLOUDINARY_UPLOAD_TIMEOUT_MS || 180000));
  if (!response.ok) throw await buildHttpError(response, "Cloudinary upload failed");
  const payload = await response.json();
  return {
    secureUrl: payload.secure_url || cloudinaryDeliveryUrl(resourceType, payload.public_id || options.publicId),
    publicId: payload.public_id || options.publicId,
    resourceType: payload.resource_type || resourceType,
    bytes: Number(payload.bytes || buffer.length),
    format: payload.format || ""
  };
}

function signCloudinaryParams(params, apiSecret) {
  const base = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return crypto.createHash("sha1").update(`${base}${apiSecret}`).digest("hex");
}

function cloudinaryDeliveryUrl(resourceType, publicId) {
  const config = getCloudinaryConfig();
  const cleanPublicId = String(publicId || "").split("/").map(encodeURIComponent).join("/");
  return config ? `https://res.cloudinary.com/${encodeURIComponent(config.cloudName)}/${resourceType}/upload/${cleanPublicId}` : "";
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

async function buildJobZip(job) {
  const entries = [];
  const usedNames = new Set();

  for (const [index, output] of (job.outputs || []).entries()) {
    const data = await readJobOutputBuffer(job, output).catch(() => null);
    if (!data) continue;

    let name = sanitizeZipEntryName(outputFileName(output, index)) || `reel-${index + 1}.mp4`;
    if (usedNames.has(name)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      name = `${base}-${index + 1}${ext}`;
    }
    usedNames.add(name);

    entries.push({
      name,
      data: data.buffer,
      mtime: data.mtime || new Date()
    });
  }

  if (entries.length === 0) {
    throw new Error("У этой задачи пока нет готовых MP4");
  }

  return createZipBuffer(entries);
}

async function readJobOutputBuffer(job, output) {
  const filePath = resolveJobOutputPath(job, output);
  if (filePath) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat?.isFile()) {
      return {
        buffer: await fsp.readFile(filePath),
        mtime: stat.mtime
      };
    }
  }

  const remoteUrl = isHttpUrl(output?.file) ? output.file : output?.storage?.url;
  if (!remoteUrl || !isHttpUrl(remoteUrl)) return null;
  const response = await fetchWithTimeout(remoteUrl, {
    method: "GET"
  }, Number(process.env.REMOTE_ASSET_DOWNLOAD_TIMEOUT_MS || 180000));
  if (!response.ok) throw await buildHttpError(response, "Remote reel download failed");
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mtime: output?.storage?.savedAt ? new Date(output.storage.savedAt) : new Date()
  };
}

function outputFileName(output, index) {
  const local = output?.localFile || output?.file || "";
  try {
    const parsed = isHttpUrl(local) ? new URL(local) : null;
    const candidate = parsed ? parsed.pathname : local;
    const name = path.basename(candidate);
    return name || `reel-${index + 1}.mp4`;
  } catch {
    return `reel-${index + 1}.mp4`;
  }
}

function resolveJobOutputPath(job, output) {
  const outputFile = output?.localFile || output?.file;
  const prefix = `/jobs/${job.id}/`;
  if (!outputFile || !String(outputFile).startsWith(prefix)) return null;
  const relative = String(outputFile).slice(prefix.length);
  const filePath = path.resolve(job.dir, relative);
  const root = path.resolve(job.dir);
  return filePath === root || filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
}

function sanitizeZipEntryName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function createZipBuffer(entries) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.mtime || new Date());
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...fileParts, ...centralParts, end]);
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(dateValue) {
  const date = new Date(dateValue);
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

async function generateCoverForOutput(job, outputIndex, description, settingsInput = {}) {
  const output = job.outputs?.[outputIndex];
  if (!output) {
    throw new Error("Reel not found");
  }
  const settings = normalizeCoverSettings(settingsInput);
  const generatedDescription = generateReelDescription(output);
  const coverDescription = generatedDescription || description || output.description || "";
  const headline = buildCoverHeadline({ description: coverDescription, text: output.text || "", title: job.metadata?.title || "" });
  const coversDir = path.join(job.dir, "covers");
  await fsp.mkdir(coversDir, { recursive: true });

  let referenceFrame = null;
  if (settings.frameReference) {
    try {
      referenceFrame = await captureReelReferenceFrame(job, output, outputIndex, coversDir);
    } catch (error) {
      log(job, `Не удалось взять кадр для обложки: ${shortError(error)}`);
    }
  }

  const prompt = buildCoverPrompt(job, output, coverDescription, settings, null, headline);
  const referencePrompt = buildCoverPrompt(job, output, coverDescription, settings, referenceFrame, headline);
  let image = null;
  try {
    image = await requestCoverImage({ prompt, referencePrompt, referenceImage: referenceFrame, job });
    try {
      image = await renderAiCoverWithReadableText({
        job,
        output,
        outputIndex,
        description: coverDescription,
        settings,
        coversDir,
        image,
        headline
      });
    } catch (textError) {
      if (!referenceFrame?.path) throw textError;
      log(job, `AI-фон готов, но локальный текст не наложился; делаю обложку из кадра: ${shortError(textError)}`);
      image = await renderLocalFrameCover({
        job,
        output,
        outputIndex,
        description: coverDescription,
        settings,
        referenceFrame,
        coversDir,
        headline,
        fallbackReason: shortError(textError)
      });
    }
  } catch (error) {
    if (!referenceFrame?.path) throw error;
    log(job, `AI-генератор не ответил, делаю локальную обложку из кадра: ${shortError(error)}`);
    image = await renderLocalFrameCover({
      job,
      output,
      outputIndex,
      description: coverDescription,
      settings,
      referenceFrame,
      coversDir,
      headline,
      fallbackReason: shortError(error)
    });
  }

  const coverName = `reel-${outputIndex + 1}-cover.${imageExtension(image.mimeType || "image/png")}`;
  const relativePath = path.join("covers", coverName);
  const coverLocalPath = path.join(job.dir, relativePath);
  const coverLocalFile = `/jobs/${job.id}/${relativePath.split(path.sep).join("/")}`;
  await fsp.writeFile(coverLocalPath, image.buffer);
  const coverAsset = {
    file: coverLocalFile,
    localFile: coverLocalFile
  };
  await persistJobAsset(job, coverAsset, {
    localPath: coverLocalPath,
    kind: "cover",
    resourceType: "image",
    mimeType: image.mimeType || "image/png",
    publicId: `${CLOUDINARY_FOLDER}/${job.id}/covers/reel-${outputIndex + 1}-cover`,
    logLabel: `обложка Reel ${outputIndex + 1}`
  });

  output.cover = {
    file: coverAsset.file,
    localFile: coverLocalFile,
    referenceFrame: referenceFrame?.file || "",
    provider: image.provider,
    model: image.model,
    mimeType: image.mimeType || "image/png",
    size: image.size,
    quality: image.quality || "",
    generatedAt: iso(),
    revisedPrompt: image.revisedPrompt || "",
    promptSource: "transcript-description",
    headline: image.headline || headline,
    rawFile: image.rawFile || "",
    typography: image.typography || "",
    description: coverDescription,
    fallbackReason: image.fallbackReason || "",
    storage: coverAsset.storage || null
  };
  output.description = coverDescription;
  log(job, `Обложка готова: ${coverName}`);
  await saveJob(job);
  await persistJobSnapshot(job);
  return output.cover;
}

async function captureReelReferenceFrame(job, output, outputIndex, coversDir) {
  const sourcePath = resolveJobSourcePath(job);
  const videoPath = sourcePath || resolveJobOutputPath(job, output);
  if (!videoPath) return null;

  const frameName = `reel-${outputIndex + 1}-reference.jpg`;
  const framePath = path.join(coversDir, frameName);
  const duration = Math.max(0.4, Number(output.duration || 0));
  const sourceDuration = Math.max(0.4, Number(job.source?.duration || duration));
  const timestamp = sourcePath
    ? Math.max(0.2, Math.min(sourceDuration - 0.2, Number(output.start || 0) + duration * 0.5))
    : Math.max(0.2, Math.min(duration - 0.2, duration * 0.5));
  const frameFilter = sourcePath
    ? "[0:v]split=2[v0][v1];[v0]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=18:1,eq=brightness=-0.07:saturation=0.85[bg];[v1]scale=720:1280:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1"
    : "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2";

  await runCommand("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    timestamp.toFixed(2),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    frameFilter,
    "-q:v",
    "4",
    framePath
  ], { cwd: job.dir, logStdout: false }, job);

  const buffer = await fsp.readFile(framePath);
  const frameAsset = {
    file: `/jobs/${job.id}/covers/${frameName}`,
    localFile: `/jobs/${job.id}/covers/${frameName}`
  };
  await persistJobAsset(job, frameAsset, {
    localPath: framePath,
    kind: "reference-frame",
    resourceType: "image",
    mimeType: "image/jpeg",
    publicId: `${CLOUDINARY_FOLDER}/${job.id}/covers/reel-${outputIndex + 1}-reference`,
    logLabel: `референс-кадр Reel ${outputIndex + 1}`
  });
  return {
    name: frameName,
    path: framePath,
    file: frameAsset.file,
    localFile: frameAsset.localFile,
    storage: frameAsset.storage || null,
    mimeType: "image/jpeg",
    data: buffer.toString("base64")
  };
}

function resolveJobSourcePath(job) {
  if (!job.source?.file) return null;
  const filePath = path.resolve(job.dir, String(job.source.file));
  const root = path.resolve(job.dir);
  return filePath === root || filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
}

async function renderLocalFrameCover({ job, output, outputIndex, description, settings, referenceFrame, coversDir, headline, fallbackReason }) {
  const localName = `reel-${outputIndex + 1}-local-cover.png`;
  const localPath = path.join(coversDir, localName);
  const planPath = path.join(coversDir, `reel-${outputIndex + 1}-local-cover.json`);

  await fsp.writeFile(planPath, JSON.stringify({
    frame: referenceFrame.path,
    output: localPath,
    title: job.metadata?.title || "",
    headline: headline || buildCoverHeadline({ description, text: output.text || "", title: job.metadata?.title || "" }),
    description,
    reelText: output.text || "",
    settings,
    reelNumber: outputIndex + 1
  }, null, 2));

  await runCommand("python3", [
    path.join(ROOT, "scripts", "render_frame_cover.py"),
    planPath
  ], { cwd: ROOT, logStdout: false }, job);

  return {
    buffer: await fsp.readFile(localPath),
    provider: "local-frame",
    model: "Pillow frame cover",
    mimeType: "image/png",
    size: "9:16 1080x1920",
    quality: "fallback",
    revisedPrompt: "",
    headline: headline || "",
    typography: "local-pillow",
    fallbackReason
  };
}

async function renderAiCoverWithReadableText({ job, output, outputIndex, description, settings, coversDir, image, headline }) {
  const rawExt = imageExtension(image.mimeType || "image/png");
  const rawName = `reel-${outputIndex + 1}-ai-raw.${rawExt}`;
  const rawPath = path.join(coversDir, rawName);
  const localName = `reel-${outputIndex + 1}-ai-text-cover.png`;
  const localPath = path.join(coversDir, localName);
  const planPath = path.join(coversDir, `reel-${outputIndex + 1}-ai-text-cover.json`);
  const safeHeadline = headline || buildCoverHeadline({ description, text: output.text || "", title: job.metadata?.title || "" });

  await fsp.writeFile(rawPath, image.buffer);
  await fsp.writeFile(planPath, JSON.stringify({
    background: rawPath,
    output: localPath,
    title: job.metadata?.title || "",
    headline: safeHeadline,
    description,
    reelText: output.text || "",
    settings,
    reelNumber: outputIndex + 1,
    provider: image.provider || "",
    model: image.model || ""
  }, null, 2));

  log(job, `Накладываю читаемый заголовок на обложку: ${safeHeadline}`);
  await runCommand("python3", [
    path.join(ROOT, "scripts", "render_frame_cover.py"),
    planPath
  ], { cwd: ROOT, logStdout: false }, job);

  return {
    ...image,
    buffer: await fsp.readFile(localPath),
    mimeType: "image/png",
    size: "9:16 1080x1920",
    quality: image.quality ? `${image.quality}+readable-text` : "readable-text",
    headline: safeHeadline,
    rawFile: `/jobs/${job.id}/covers/${rawName}`,
    typography: "local-pillow"
  };
}

function buildCoverPrompt(job, output, description, settings = normalizeCoverSettings(), referenceFrame = null, headline = "") {
  const title = cleanPromptText(job.metadata?.title || "");
  const reelText = cleanPromptText(output.text || "");
  const caption = cleanPromptText(description || "");
  const visualTheme = pickCoverTheme(`${caption} ${reelText}`);

  return [
    "Create a premium vertical cover image for an Instagram Reels / YouTube Shorts video.",
    `Canvas: exact ${GEMINI_COVER_ASPECT_RATIO} portrait cover, cinematic thumbnail composition.`,
    referenceFrame ? "A frame from the actual reel is attached. Use it as the primary visual reference for the subject, setting, clothing, lighting, lens feel, and composition, then polish it into a clean original cover image." : "",
    "No text, no captions, no letters, no numbers, no logos, no watermarks, no UI, no social media frame.",
    coverTextZoneText(settings.textZone),
    headline ? `The app will add this headline locally after generation: ${shortenPromptText(headline, 90)}. Leave clean empty visual space for it, but do not render any words yourself.` : "",
    "Make the image emotionally clear at mobile size: one strong focal subject, high contrast, clean silhouette, polished lighting.",
    coverStyleText(settings.style),
    coverMotionText(settings.motion),
    coverPaletteText(settings.palette),
    `Visual direction: ${visualTheme}.`,
    title ? `Source video context: ${shortenPromptText(title, 160)}.` : "",
    caption ? `Reel description to visualize: ${shortenPromptText(caption, 700)}.` : "",
    reelText ? `Transcript fragment context: ${shortenPromptText(reelText, 500)}.` : "",
    "Do not reproduce a raw video player screenshot. Remove any interface marks, subtitles, compression artifacts, and accidental blur.",
    "Keep the final image suitable for Christian, motivational, story, sermon, interview, or testimony content when the context suggests it."
  ].filter(Boolean).join(" ");
}

function normalizeCoverSettings(input = {}) {
  const styleAliases = {
    cinematic: "cutout",
    realistic: "poster",
    documentary: "magazine",
    premium: "headline",
    dramatic: "split"
  };
  const rawStyle = String(input.style || "").toLowerCase().trim();
  return {
    frameReference: input.frameReference !== false,
    style: pickAllowed(styleAliases[rawStyle] || rawStyle, ["cutout", "poster", "magazine", "split", "headline"], "cutout"),
    motion: pickAllowed(input.motion, ["calm", "dynamic", "closeup", "breakthrough"], "dynamic"),
    palette: pickAllowed(input.palette, ["warm", "contrast", "clean", "shadow-light"], "warm"),
    textZone: pickAllowed(input.textZone, ["top", "center", "bottom", "none"], "top")
  };
}

function pickAllowed(value, allowed, fallback) {
  const normalized = String(value || "").toLowerCase().trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

function coverStyleText(style) {
  return {
    cutout: "Layout style: trend thumbnail with the real person or symbolic subject as a foreground sticker, enlarged over a designed blurred background, with a blank title-safe area and no typography.",
    poster: "Layout style: cinematic poster based on the actual frame, dramatic light, polished thumbnail hierarchy, blank space for a local title overlay, no typography.",
    magazine: "Layout style: premium magazine/social cover, framed photo card, refined negative space and graphic accents, but no printed words or masthead.",
    split: "Layout style: split composition with a clean blank title zone and the reel frame as the hero visual, bold contrast and clean separation, no typography.",
    headline: "Layout style: headline-safe thumbnail composition with oversized empty negative space for local text overlay and the real person as supporting foreground, no typography."
  }[style] || coverStyleText("cutout");
}

function coverMotionText(motion) {
  return {
    calm: "Energy: calm, contemplative, still, emotionally focused.",
    dynamic: "Energy: visible movement and forward momentum while keeping the subject sharp and readable.",
    closeup: "Energy: intimate close-up with strong eyes or expressive hands as the focal point.",
    breakthrough: "Energy: breakthrough moment, moving from pressure into hope, a feeling of release."
  }[motion] || coverMotionText("dynamic");
}

function coverPaletteText(palette) {
  return {
    warm: "Color mood: warm natural highlights, deep but gentle contrast, hopeful atmosphere.",
    contrast: "Color mood: high contrast, crisp separation between subject and background, bold mobile readability.",
    clean: "Color mood: clean neutral editorial tones, bright face/subject, minimal visual noise.",
    "shadow-light": "Color mood: shadow turning into light, moody edges with a hopeful warm highlight."
  }[palette] || coverPaletteText("warm");
}

function coverTextZoneText(textZone) {
  return {
    top: "Leave a calm readable area in the upper third where title text can be added later by the app.",
    center: "Leave a calm readable area near the center without covering the main face or key subject.",
    bottom: "Leave a calm readable area in the lower third where title text can be added later by the app.",
    none: "Do not reserve an empty text area; make the whole frame work as a finished cover without text."
  }[textZone] || coverTextZoneText("top");
}

function pickCoverTheme(text) {
  const lower = cleanPromptText(text).toLocaleLowerCase("ru-RU");
  if (/счаст|деньг|миллион|бизнес|тачк|богат|успех/.test(lower)) {
    return "a powerful contrast between money/status symbols and deeper happiness, expressive human reflection, warm light, subtle blurred luxury cues, honest spiritual tension";
  }
  if (/бог|господ|вер|псалом|молит|иисус|христ|бож/.test(lower)) {
    return "quiet spiritual atmosphere, warm dawn light, a human silhouette in contemplation, subtle sense of hope and protection";
  }
  if (/убега|беж|бег|устал|втор(ое|ом) дых|сил|путь/.test(lower)) {
    return "a determined person on an open road at sunrise, motion, endurance, breakthrough, hopeful tension";
  }
  if (/страх|тревог|злюсь|разруш|боль|рана/.test(lower)) {
    return "emotional close-up, shadow turning into warm light, inner conflict resolving into courage";
  }
  if (/мама|семь|сест|дет|любов/.test(lower)) {
    return "tender family-story mood, warm window light, intimate human emotion without showing readable documents";
  }
  return "dramatic human story moment, warm cinematic light, expressive atmosphere, clean background depth";
}

function buildCoverHeadline(input = {}) {
  const description = normalizeDescriptionText(input.description || "");
  const reelText = normalizeDescriptionText(input.text || input.reelText || "");
  const title = normalizeDescriptionText(input.title || "");
  const combined = `${description} ${reelText} ${title}`.toLocaleLowerCase("ru-RU");

  if (/счаст|деньг|миллион|бизнес|тачк|богат|успех/.test(combined)) {
    return "СЧАСТЬЕ НЕ В ДЕНЬГАХ";
  }
  if (/мама|семь|сест|дет|сынок|доч/.test(combined)) {
    return "ДОСМОТРИ ДО КОНЦА";
  }
  if (/убега|беж|бег|устал|втор(ое|ом) дых|сил|путь/.test(combined)) {
    return "ТЫ СМОЖЕШЬ ЕЩЕ";
  }
  if (/бог|господ|вер|псалом|молит|иисус|христ|бож|чуд/.test(combined)) {
    return "БОГ ОТВЕТИТ ИНАЧЕ";
  }
  if (/страх|тревог|злюсь|разруш|боль|рана|стыд/.test(combined)) {
    return "ПРОБЛЕМА НЕ ТАМ";
  }

  const fromDescription = firstHeadlineCandidate(description);
  if (fromDescription) return fromDescription;
  const fromText = firstHeadlineCandidate(reelText);
  if (fromText) return fromText;
  return firstHeadlineCandidate(title) || "ДОСМОТРИ ДО КОНЦА";
}

function firstHeadlineCandidate(value) {
  let text = stripHashtags(value);
  text = text
    .replace(/[“”„"]/g, "")
    .replace(/^[\s.,:;!?-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const sentence = text.match(/^(.{14,}?[.!?])(?:\s|$)/);
  if (sentence) text = sentence[1];
  text = text
    .replace(/^(возможно|иногда|эти слова|этот фрагмент|здесь|короткая история)\s*,?\s*/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();

  const words = text.split(/\s+/).filter(Boolean);
  const picked = [];
  for (const word of words) {
    const candidate = [...picked, word].join(" ");
    if (picked.length >= 5 || candidate.length > 34) break;
    picked.push(word);
  }
  return picked.length >= 2 ? picked.join(" ").toLocaleUpperCase("ru-RU") : "";
}

function stripHashtags(value) {
  return String(value || "").replace(/#\S+/g, " ");
}

function generateReelDescription(output) {
  const text = normalizeDescriptionText(output?.text || "");
  const hook = buildClickbaitHook(text);
  const body = buildDescriptionBody(text);
  const cta = buildDescriptionCta(text);
  const hashtags = buildHashtags(text);
  return [
    hook,
    body,
    cta,
    hashtags
  ].filter(Boolean).join("\n\n");
}

function normalizeDescriptionText(value) {
  return String(value || "")
    .replace(/\.\.\./g, " ")
    .replace(/[“”„"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildClickbaitHook(text) {
  const lower = text.toLocaleLowerCase("ru-RU");
  if (/счаст|деньг|миллион|бизнес|тачк|богат|успех/.test(lower)) {
    return "Все думают, что счастье начнется с денег. Но дальше мысль разворачивается совсем иначе.";
  }
  if (/убега|беж|бег|устал|втор(ое|ом) дых|сил/.test(lower)) {
    return "Вы можете бежать всю жизнь и так и не понять, от чего на самом деле спасаетесь.";
  }
  if (/страх|тревог|злюсь|разруш|боль|не так/.test(lower)) {
    return "Возможно, проблема не там, где вы привыкли ее искать.";
  }
  if (/мама|семь|сест|дет/.test(lower)) {
    return "Он хотел просто увидеть маму. Но дальше начинается самое сильное.";
  }
  if (/бог|господ|вер|псалом|молит|чуд|бож/.test(lower)) {
    return "Иногда Бог отвечает не так, как мы ожидали.";
  }
  return "Эти слова сначала звучат просто. А потом попадают прямо в точку.";
}

function buildDescriptionBody(text) {
  const lower = text.toLocaleLowerCase("ru-RU");
  if (/счаст|деньг|миллион|бизнес|тачк|богат|успех/.test(lower)) {
    return "Этот фрагмент цепляет тем, что честно бьет по привычной мечте о деньгах, статусе и красивой жизни, а потом возвращает к вопросу: где на самом деле начинается счастье.";
  }
  if (/убега|беж|бег|устал|втор(ое|ом) дых|сил/.test(lower)) {
    return "Этот фрагмент про момент, когда усталость становится сигналом: пора остановиться, честно посмотреть внутрь и понять, ради чего ты продолжаешь путь.";
  }
  if (/страх|тревог|злюсь|разруш|боль|не так/.test(lower)) {
    return "Здесь очень точно показано, как старые раны влияют на наши решения, реакции и веру в то, что хорошее вообще возможно.";
  }
  if (/мама|семь|сест|дет/.test(lower)) {
    return "Короткая история о любви, ожидании и словах, которые нельзя обрывать на самом важном месте.";
  }
  if (/бог|господ|вер|псалом|молит|чуд|бож/.test(lower)) {
    return "Сильная мысль о вере, Божьей помощи и моменте, когда нужно не сдаться, а дослушать до конца.";
  }
  return trimDescription(text, 220);
}

function buildDescriptionCta(text) {
  const lower = text.toLocaleLowerCase("ru-RU");
  if (/счаст|деньг|миллион|бизнес|тачк|богат|успех/.test(lower)) {
    return "Досмотри до конца - там самая важная мысль про счастье и веру.";
  }
  if (/убега|беж|бег|устал|втор(ое|ом) дых|сил/.test(lower)) {
    return "Досмотри до конца - финальная мысль может оказаться именно про тебя.";
  }
  if (/бог|господ|вер|псалом|молит|чуд|бож/.test(lower)) {
    return "Сохрани, если сейчас нужен знак продолжать.";
  }
  return "Досмотри до конца и сохрани, если зацепило.";
}

function trimDescription(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return capitalize(text);
  const slice = text.slice(0, maxLength);
  const boundary = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (boundary > 120) return capitalize(slice.slice(0, boundary + 1));
  return `${capitalize(slice.replace(/\s+\S*$/, ""))}...`;
}

function buildHashtags(text) {
  const lower = text.toLocaleLowerCase("ru-RU");
  const tags = [];
  if (/счаст|деньг|миллион|бизнес|тачк|богат|успех/.test(lower)) tags.push("#счастье", "#деньги");
  if (/бог|господ|вер|псалом|молит|бож/.test(lower)) tags.push("#вера", "#бог");
  if (/убега|беж|бег|устал|втор(ое|ом) дых|сил/.test(lower)) tags.push("#несдавайся");
  if (/страх|тревог|злюсь|разруш|боль/.test(lower)) tags.push("#психология");
  if (/мама|семь|сест|дет/.test(lower)) tags.push("#семья");
  tags.push("#мотивация", "#история", "#рилс");
  return [...new Set(tags)].slice(0, 5).join(" ");
}

function capitalize(value) {
  const text = String(value || "").trim();
  return text ? text[0].toLocaleUpperCase("ru-RU") + text.slice(1) : "";
}

function cleanPromptText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenPromptText(value, maxLength) {
  const text = cleanPromptText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).replace(/\s+\S*$/, "")}...`;
}

async function requestCoverImage({ prompt, referencePrompt, referenceImage = null, job = null }) {
  const providers = getEnabledImageProviders();
  const errors = [];

  for (const provider of providers) {
    try {
      if (provider === "gemini") {
        if (job) log(job, "Генерирую обложку через Gemini");
        const image = await requestGeminiImage(referenceImage ? referencePrompt : prompt, referenceImage);
        recordImageProviderResult(provider, true, null, image.model);
        return image;
      }

      if (provider === "cloudflare") {
        if (job) log(job, "Gemini недоступен, пробую Cloudflare Workers AI / Flux");
        const image = await requestCloudflareCoverImage(prompt);
        recordImageProviderResult(provider, true, null, image.model);
        return image;
      }

      if (provider === "huggingface") {
        if (job) log(job, "Пробую Hugging Face / Flux");
        const image = await requestHuggingFaceCoverImage(prompt);
        recordImageProviderResult(provider, true, null, image.model);
        return image;
      }

      if (provider === "qwen") {
        if (job) log(job, "Пробую Qwen Image / DashScope");
        const image = await requestDashscopeQwenCoverImage(prompt);
        recordImageProviderResult(provider, true, null, image.model);
        return image;
      }

      if (provider === "pollinations") {
        if (job) log(job, "Пробую бесплатный Pollinations / Flux");
        const image = await requestPollinationsCoverImage(prompt);
        recordImageProviderResult(provider, true, null, image.model);
        return image;
      }
    } catch (error) {
      recordImageProviderResult(provider, false, error, getImageProviderModelName(provider));
      errors.push(error);
    }
  }

  throw buildCoverProvidersUnavailableError(errors);
}

function getCoverProviderOrder() {
  if (COVER_IMAGE_PROVIDER !== "auto") return [COVER_IMAGE_PROVIDER];
  return splitList(process.env.AI_IMAGE_PROVIDER_ORDER || DEFAULT_IMAGE_PROVIDER_ORDER);
}

function getEnabledImageProviders() {
  const providers = [];
  const order = getCoverProviderOrder();
  for (const provider of order.length ? order : ["gemini", "cloudflare", "huggingface", "qwen", "pollinations"]) {
    const normalized = String(provider || "").trim().toLowerCase();
    if (!isImageProviderWithinDailyLimit(normalized)) continue;
    if (normalized === "gemini" && geminiApiKey()) providers.push("gemini");
    if (normalized === "cloudflare" && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) providers.push("cloudflare");
    if ((normalized === "huggingface" || normalized === "hf") && getHuggingFaceToken()) providers.push("huggingface");
    if ((normalized === "qwen" || normalized === "dashscope") && readBooleanEnv("DASHSCOPE_IMAGE_ENABLED") === true && getDashscopeApiKey()) providers.push("qwen");
    if (normalized === "pollinations" && readBooleanEnv("POLLINATIONS_IMAGE_ENABLED") !== false) providers.push("pollinations");
  }
  return [...new Set(providers)];
}

function normalizeCoverImageProvider(value) {
  const provider = String(value || "").toLowerCase().trim();
  if (["auto", "gemini", "cloudflare", "huggingface", "hf", "qwen", "dashscope", "pollinations"].includes(provider)) {
    return provider === "hf" ? "huggingface" : (provider === "dashscope" ? "qwen" : provider);
  }
  return "auto";
}

function normalizeGeminiImageSize(value) {
  const size = String(value || "").toUpperCase().trim();
  if (["1K", "2K", "4K"].includes(size)) return size;
  return "1K";
}

function buildCoverProviderPrompt(prompt, maxLength = 1800) {
  return shortenPromptText([
    prompt,
    "Provider fallback notes: generate only the visual background for a premium 9:16 vertical cover from the transcript description. The app will add all typography locally after generation. Do not draw readable or fake letters, numbers, logos, UI, watermarks, captions, subtitles, screenshots, poster text, labels, or social-media chrome. Strong single focal subject, cinematic light, mobile-readable contrast, polished editorial style, clean title-safe negative space."
  ].join(" "), maxLength);
}

async function requestCloudflareCoverImage(prompt) {
  const imagePrompt = buildCoverProviderPrompt(prompt, 1900);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/${getCloudflareImageModel()}`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      prompt: imagePrompt,
      seed: getCoverImageSeed(imagePrompt),
      steps: Math.max(4, Math.min(8, Number(process.env.CLOUDFLARE_IMAGE_STEPS || 8)))
    })
  }, DEFAULT_IMAGE_PROVIDER_TIMEOUT_MS);

  if (!response.ok) throw await buildHttpError(response, "Cloudflare Workers AI image API failed");

  const contentType = String(response.headers.get("content-type") || "");
  if (contentType.startsWith("image/")) {
    return imageFromArrayBuffer("cloudflare", getCloudflareImageModel(), contentType, await response.arrayBuffer(), imagePrompt);
  }

  const payload = await response.json();
  const imageBase64 = payload?.result?.image || payload?.image || "";
  if (!imageBase64) throw new Error("Cloudflare Workers AI did not return an image.");
  return imageFromBase64("cloudflare", getCloudflareImageModel(), "image/jpeg", imageBase64, imagePrompt);
}

async function requestHuggingFaceCoverImage(prompt) {
  const imagePrompt = buildCoverProviderPrompt(prompt, 1600);
  const model = getHuggingFaceImageModel();
  const endpoint = process.env.HUGGINGFACE_IMAGE_ENDPOINT || `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getHuggingFaceToken()}`,
      "content-type": "application/json",
      accept: "image/png,image/jpeg,image/webp,application/json"
    },
    body: JSON.stringify({
      inputs: imagePrompt,
      parameters: {
        seed: getCoverImageSeed(imagePrompt),
        width: 720,
        height: 1280,
        num_inference_steps: Math.max(4, Math.min(8, Number(process.env.HUGGINGFACE_IMAGE_STEPS || 8)))
      },
      options: {
        wait_for_model: true
      }
    })
  }, DEFAULT_IMAGE_PROVIDER_TIMEOUT_MS);

  if (!response.ok) throw await buildHttpError(response, "Hugging Face image API failed");

  const contentType = String(response.headers.get("content-type") || "");
  if (contentType.startsWith("application/json")) {
    const payload = await response.json();
    const base64 = extractBase64ImageFromPayload(payload);
    if (!base64) throw new Error("Hugging Face did not return an image.");
    return imageFromBase64("huggingface", `huggingface/${model}`, "image/png", base64, imagePrompt);
  }

  return imageFromArrayBuffer("huggingface", `huggingface/${model}`, contentType || "image/png", await response.arrayBuffer(), imagePrompt);
}

async function requestDashscopeQwenCoverImage(prompt) {
  const imagePrompt = buildCoverProviderPrompt(prompt, 1600);
  const endpoint = `${normalizeBaseUrl(process.env.DASHSCOPE_BASE_URL || DEFAULT_DASHSCOPE_BASE_URL)}/services/aigc/multimodal-generation/generation`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getDashscopeApiKey()}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      model: getDashscopeImageModel(),
      input: {
        messages: [
          {
            role: "user",
            content: [{ text: imagePrompt }]
          }
        ]
      },
      parameters: {
        seed: getCoverImageSeed(imagePrompt)
      }
    })
  }, DEFAULT_IMAGE_PROVIDER_TIMEOUT_MS);

  if (!response.ok) throw await buildHttpError(response, "Qwen/DashScope image API failed");

  const payload = await response.json();
  const base64 = extractBase64ImageFromPayload(payload);
  if (base64) return imageFromBase64("qwen", `qwen/${getDashscopeImageModel()}`, "image/png", base64, imagePrompt);

  const imageUrl = extractImageUrlFromPayload(payload);
  if (!imageUrl) throw new Error("Qwen/DashScope did not return an image URL.");

  const imageResponse = await fetchWithTimeout(imageUrl, {
    method: "GET",
    headers: { accept: "image/png,image/jpeg,image/webp,*/*" }
  }, DEFAULT_IMAGE_PROVIDER_TIMEOUT_MS);
  if (!imageResponse.ok) throw await buildHttpError(imageResponse, "Qwen/DashScope image download failed");

  const mimeType = String(imageResponse.headers.get("content-type") || "image/png").split(";")[0].trim();
  return imageFromArrayBuffer("qwen", `qwen/${getDashscopeImageModel()}`, mimeType, await imageResponse.arrayBuffer(), imagePrompt);
}

async function requestPollinationsCoverImage(prompt) {
  const imagePrompt = buildCoverProviderPrompt(prompt, 1800);
  const errors = [];

  for (const pollinationsModel of getPollinationsImageModels()) {
    const baseUrl = normalizeBaseUrl(process.env.POLLINATIONS_BASE_URL || DEFAULT_POLLINATIONS_BASE_URL);
    const url = new URL(getPollinationsImagePath(baseUrl, imagePrompt), baseUrl);
    url.searchParams.set("model", pollinationsModel);
    url.searchParams.set("width", "720");
    url.searchParams.set("height", "1280");
    url.searchParams.set("seed", String(getCoverImageSeed(imagePrompt)));
    url.searchParams.set("nologo", "true");
    url.searchParams.set("private", "true");
    url.searchParams.set("safe", "true");
    if (pollinationsModel !== "turbo") url.searchParams.set("enhance", "true");
    if (process.env.POLLINATIONS_API_KEY) url.searchParams.set("key", process.env.POLLINATIONS_API_KEY);

    for (let attempt = 1; attempt <= getPollinationsRetryAttempts(); attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, {
          method: "GET",
          headers: {
            accept: "image/png,image/jpeg,image/webp,*/*",
            "user-agent": "auto-reels-pipeline/0.1"
          }
        }, DEFAULT_POLLINATIONS_TIMEOUT_MS);

        if (!response.ok) throw await buildHttpError(response, "Pollinations image API failed");

        const mimeType = String(response.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
        if (!mimeType.startsWith("image/")) throw new Error("Pollinations did not return an image.");
        return imageFromArrayBuffer("pollinations", `pollinations/${pollinationsModel}`, mimeType, await response.arrayBuffer(), imagePrompt);
      } catch (error) {
        errors.push(error);
        if (attempt < getPollinationsRetryAttempts() && isTemporaryProviderBackoffError(error)) {
          await delay(getPollinationsRetryDelayMs() * attempt);
          continue;
        }
        break;
      }
    }
  }

  throw combineProviderErrors(errors);
}

function geminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
}

async function requestGeminiImage(prompt, referenceImage = null) {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY не задан. Добавьте его в .env и перезапустите сервер.");
  }
  const parts = [];
  if (referenceImage?.data && referenceImage?.mimeType) {
    parts.push({
      inlineData: {
        mimeType: referenceImage.mimeType,
        data: referenceImage.data
      }
    });
  }
  parts.push({ text: prompt });

  const modelCandidates = getGeminiModelCandidates();
  let response = null;
  let data = null;
  let usedModel = modelCandidates[0] || GEMINI_IMAGE_MODEL;

  for (const candidateModel of modelCandidates) {
    usedModel = candidateModel;
    response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent`,
      {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts
          }
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: GEMINI_COVER_ASPECT_RATIO,
            imageSize: GEMINI_IMAGE_SIZE
          }
        }
      })
      },
      DEFAULT_IMAGE_PROVIDER_TIMEOUT_MS
    );

    data = await response.json().catch(() => ({}));
    if (response.ok || !isRetryableProviderStatus(response.status)) break;
  }

  if (!response.ok) {
    const message = data.error?.message || `Gemini image generation failed with HTTP ${response.status}`;
    throw new Error(friendlyGeminiImageError(message));
  }

  const inline = extractGeminiInlineImage(data);
  if (!inline?.data) {
    throw new Error("Gemini не вернул изображение. Попробуйте еще раз.");
  }

  return {
    buffer: Buffer.from(inline.data, "base64"),
    provider: "gemini",
    model: usedModel,
    mimeType: inline.mimeType || inline.mime_type || "image/png",
    size: `${GEMINI_COVER_ASPECT_RATIO} ${GEMINI_IMAGE_SIZE}`,
    quality: GEMINI_IMAGE_SIZE,
    revisedPrompt: ""
  };
}

function extractGeminiInlineImage(payload) {
  for (const candidate of payload.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) return part.inlineData;
      if (part.inline_data?.data) return part.inline_data;
    }
  }
  return null;
}

async function requestOpenAIImage(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY не настроен. Создайте ключ в .env и перезапустите сервер.");
  }

  const size = normalizeCoverSize(COVER_IMAGE_SIZE);
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size,
      quality: COVER_IMAGE_QUALITY,
      output_format: "png",
      n: 1
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `OpenAI image generation failed with HTTP ${response.status}`;
    throw new Error(friendlyOpenAIImageError(message));
  }

  const first = data.data?.[0] || {};
  const b64 = first.b64_json || first.image_base64;
  if (!b64) {
    throw new Error("OpenAI не вернул изображение в ответе");
  }

  return {
    buffer: Buffer.from(b64, "base64"),
    provider: "openai",
    model: OPENAI_IMAGE_MODEL,
    mimeType: "image/png",
    size,
    quality: COVER_IMAGE_QUALITY,
    revisedPrompt: first.revised_prompt || first.revisedPrompt || ""
  };
}

function getGeminiModelCandidates() {
  return [...new Set([GEMINI_IMAGE_MODEL, ...splitList(GEMINI_IMAGE_FALLBACK_MODELS)].map(cleanPromptText).filter(Boolean))];
}

function getCloudflareImageModel() {
  return process.env.CLOUDFLARE_IMAGE_MODEL || DEFAULT_CLOUDFLARE_IMAGE_MODEL;
}

function getHuggingFaceImageModel() {
  return process.env.HUGGINGFACE_IMAGE_MODEL || DEFAULT_HUGGINGFACE_IMAGE_MODEL;
}

function getDashscopeImageModel() {
  return process.env.DASHSCOPE_IMAGE_MODEL || DEFAULT_DASHSCOPE_IMAGE_MODEL;
}

function getHuggingFaceToken() {
  return process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || "";
}

function getDashscopeApiKey() {
  return process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || "";
}

function getPollinationsImageModels() {
  const models = splitList(process.env.POLLINATIONS_IMAGE_MODEL || DEFAULT_POLLINATIONS_IMAGE_MODEL);
  return [...new Set([...models, "turbo"].map(cleanPromptText).filter(Boolean))];
}

function getPollinationsImageModel() {
  return getPollinationsImageModels()[0] || DEFAULT_POLLINATIONS_IMAGE_MODEL;
}

function getPollinationsRetryAttempts() {
  return Number.isFinite(DEFAULT_POLLINATIONS_RETRY_ATTEMPTS)
    ? Math.max(1, Math.min(5, Math.floor(DEFAULT_POLLINATIONS_RETRY_ATTEMPTS)))
    : 3;
}

function getPollinationsRetryDelayMs() {
  return Number.isFinite(DEFAULT_POLLINATIONS_RETRY_DELAY_MS)
    ? Math.max(1000, Math.min(20000, Math.floor(DEFAULT_POLLINATIONS_RETRY_DELAY_MS)))
    : 4500;
}

function getPollinationsImagePath(baseUrl, prompt) {
  const encodedPrompt = encodeURIComponent(prompt);
  return String(baseUrl || "").includes("image.pollinations.ai")
    ? `/prompt/${encodedPrompt}`
    : `/image/${encodedPrompt}`;
}

function getCoverImageSeed(prompt) {
  return Math.abs(hashString(prompt)) % 2147483647;
}

function imageExtension(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  return "png";
}

function getImageProviderModelName(provider) {
  if (provider === "gemini") return GEMINI_IMAGE_MODEL;
  if (provider === "cloudflare") return getCloudflareImageModel();
  if (provider === "huggingface") return getHuggingFaceImageModel();
  if (provider === "qwen") return getDashscopeImageModel();
  if (provider === "pollinations") return getPollinationsImageModel();
  return "";
}

function buildCoverProvidersUnavailableError(errors) {
  const combined = combineProviderErrors(errors);
  const error = new Error(
    "AI-генераторы обложки сейчас недоступны. " +
    "Проверил бесплатную цепочку провайдеров и не буду переключаться на платные модели. " +
    shortenPromptText(combined.message || "", 360)
  );
  error.statusCode = 503;
  return error;
}

function combineProviderErrors(errors) {
  const messages = (Array.isArray(errors) ? errors : [])
    .map((error) => error?.message || "")
    .filter(Boolean);
  return new Error(messages.length ? messages.slice(0, 4).join(" | ") : "AI image providers are unavailable.");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, Math.max(8000, Number(timeoutMs || DEFAULT_IMAGE_PROVIDER_TIMEOUT_MS)));

  try {
    return await fetch(url, {
      ...(options || {}),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(error?.name === "AbortError" ? "Image provider request timed out." : (error?.message || "Image provider request failed."));
  } finally {
    clearTimeout(timeout);
  }
}

async function buildHttpError(response, fallbackMessage) {
  let detail = "";
  try {
    const contentType = String(response.headers.get("content-type") || "");
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      detail = cleanPromptText(payload?.error?.message || payload?.message || payload?.msg || JSON.stringify(payload).slice(0, 260));
    } else {
      detail = cleanPromptText(await response.text());
    }
  } catch {
    detail = "";
  }
  const error = new Error(`${fallbackMessage || "Image provider failed"} HTTP ${response.status}${detail ? `: ${shortenPromptText(detail, 260)}` : "."}`);
  error.statusCode = response.status;
  return error;
}

function imageFromArrayBuffer(provider, model, mimeType, arrayBuffer, prompt) {
  const cleanMimeType = String(mimeType || "image/png").split(";")[0].trim();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) throw new Error(`${provider} returned an empty image.`);
  if (buffer.length > 18_000_000) throw new Error(`${provider} image is too large.`);
  return {
    buffer,
    provider,
    model,
    mimeType: cleanMimeType.startsWith("image/") ? cleanMimeType : "image/png",
    size: "9:16 720x1280",
    quality: provider === "pollinations" ? "free" : "free-tier",
    revisedPrompt: prompt
  };
}

function imageFromBase64(provider, model, mimeType, base64, prompt) {
  return imageFromArrayBuffer(provider, model, mimeType, Buffer.from(stripDataUrl(base64), "base64"), prompt);
}

function extractBase64ImageFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.image === "string") return stripDataUrl(payload.image);
  if (typeof payload.b64_json === "string") return stripDataUrl(payload.b64_json);
  if (payload.result && typeof payload.result.image === "string") return stripDataUrl(payload.result.image);

  const output = payload.output || payload.data || payload.results || payload.images || payload.choices;
  const queue = Array.isArray(output) ? output.slice() : output && typeof output === "object" ? [output] : [];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    if (typeof item.image === "string" && isLikelyBase64Image(item.image)) return stripDataUrl(item.image);
    if (typeof item.b64_json === "string") return stripDataUrl(item.b64_json);
    if (Array.isArray(item.content)) queue.push(...item.content);
    if (item.message && typeof item.message === "object") queue.push(item.message);
  }
  return "";
}

function extractImageUrlFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.url === "string" && /^https?:\/\//u.test(payload.url)) return payload.url;
  if (typeof payload.image_url === "string" && /^https?:\/\//u.test(payload.image_url)) return payload.image_url;

  const output = payload.output || payload.data || payload.results || payload.images || payload.choices;
  const queue = Array.isArray(output) ? output.slice() : output && typeof output === "object" ? [output] : [];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object") continue;
    if (typeof item.url === "string" && /^https?:\/\//u.test(item.url)) return item.url;
    if (typeof item.image_url === "string" && /^https?:\/\//u.test(item.image_url)) return item.image_url;
    if (typeof item.image === "string" && /^https?:\/\//u.test(item.image)) return item.image;
    if (Array.isArray(item.content)) queue.push(...item.content);
    if (item.message && typeof item.message === "object") queue.push(item.message);
  }
  return "";
}

function stripDataUrl(value) {
  return String(value || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, "");
}

function isLikelyBase64Image(value) {
  return /^data:image\//iu.test(value) || /^[A-Za-z0-9+/=]{120,}$/u.test(value);
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_POLLINATIONS_BASE_URL).replace(/\/+$/u, "");
}

function splitList(value) {
  return String(value || "").split(",").map(cleanPromptText).filter(Boolean);
}

function readBooleanEnv(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRetryableProviderStatus(statusCode) {
  return [429, 500, 502, 503, 504].includes(Number(statusCode));
}

function isTemporaryProviderBackoffError(error) {
  const status = Number(error?.statusCode);
  const message = String(error?.message || "").toLowerCase();
  return [500, 502, 503, 504].includes(status) ||
    /queue full|already queued|server busy|temporarily unavailable|try again|timed out|timeout/u.test(message);
}

function isQuotaLikeError(error) {
  const status = Number(error?.statusCode);
  const message = String(error?.message || "").toLowerCase();
  if (isTemporaryProviderBackoffError(error)) return false;
  return status === 401 ||
    status === 403 ||
    status === 429 ||
    (status === 402 && /payment|required|paywall|paid|credit|billing|insufficient|subscription/u.test(message)) ||
    /\bquota\b|rate limit|\blimit(?:ed|s)?\b|too many requests|\bcredit\b|billing|insufficient|exceeded|unauthorized|forbidden|квот|лимит|исчерпан|слишком много/u.test(message);
}

function getImageProviderDailyLimit(provider) {
  const limits = {
    gemini: Number(process.env.GEMINI_IMAGE_DAILY_LIMIT || 20),
    cloudflare: Number(process.env.CLOUDFLARE_IMAGE_DAILY_LIMIT || 40),
    huggingface: Number(process.env.HUGGINGFACE_IMAGE_DAILY_LIMIT || 6),
    qwen: Number(process.env.DASHSCOPE_IMAGE_DAILY_LIMIT || 10),
    pollinations: Number(process.env.POLLINATIONS_IMAGE_DAILY_LIMIT || 50)
  };
  const limit = limits[provider];
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

function getImageUsageDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function readImageUsageArchive() {
  try {
    return JSON.parse(fs.readFileSync(IMAGE_USAGE_PATH, "utf8"));
  } catch {
    return { version: 1, days: {} };
  }
}

function writeImageUsageArchive(archive) {
  try {
    fs.mkdirSync(path.dirname(IMAGE_USAGE_PATH), { recursive: true });
    fs.writeFileSync(IMAGE_USAGE_PATH, JSON.stringify(archive, null, 2));
  } catch {
    // Usage tracking should never break cover generation.
  }
}

function getImageProviderUsageRecord(archive, provider) {
  const dayKey = getImageUsageDateKey();
  archive.days = archive.days && typeof archive.days === "object" ? archive.days : {};
  archive.days[dayKey] = archive.days[dayKey] && typeof archive.days[dayKey] === "object" ? archive.days[dayKey] : { providers: {} };
  archive.days[dayKey].providers = archive.days[dayKey].providers && typeof archive.days[dayKey].providers === "object" ? archive.days[dayKey].providers : {};
  archive.days[dayKey].providers[provider] = archive.days[dayKey].providers[provider] && typeof archive.days[dayKey].providers[provider] === "object"
    ? archive.days[dayKey].providers[provider]
    : { success: 0, failure: 0 };
  return archive.days[dayKey].providers[provider];
}

function isImageProviderWithinDailyLimit(provider) {
  const limit = getImageProviderDailyLimit(provider);
  if (limit <= 0) return false;
  const archive = readImageUsageArchive();
  const record = getImageProviderUsageRecord(archive, provider);
  const disabledUntil = record.disabledUntil ? Date.parse(record.disabledUntil) : 0;
  if (disabledUntil && disabledUntil > Date.now()) return false;
  if (!disabledUntil && record.lastError && isQuotaLikeError({ message: record.lastError })) {
    record.disabledUntil = getNextUtcDayIso();
    writeImageUsageArchive(archive);
    return false;
  }
  return Number(record.success || 0) < limit;
}

function recordImageProviderResult(provider, ok, error, model) {
  const archive = readImageUsageArchive();
  const record = getImageProviderUsageRecord(archive, provider);
  const now = new Date();
  record.model = model || record.model || "";
  record.lastAt = now.toISOString();
  if (ok) {
    record.success = Number(record.success || 0) + 1;
    record.lastSuccessAt = record.lastAt;
    delete record.disabledUntil;
    delete record.lastError;
  } else {
    record.failure = Number(record.failure || 0) + 1;
    record.lastFailureAt = record.lastAt;
    record.lastError = error?.message ? shortenPromptText(error.message, 280) : "Image provider failed.";
    if (isQuotaLikeError(error)) record.disabledUntil = getNextUtcDayIso(now);
  }
  writeImageUsageArchive(archive);
}

function getNextUtcDayIso(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0)).toISOString();
}

function getImageProviderUsageSummary() {
  const archive = readImageUsageArchive();
  const dayKey = getImageUsageDateKey();
  const day = archive.days?.[dayKey] || { providers: {} };
  const summary = {};
  ["gemini", "cloudflare", "huggingface", "qwen", "pollinations"].forEach((provider) => {
    const record = day.providers?.[provider] || {};
    summary[provider] = {
      success: Number(record.success || 0),
      failure: Number(record.failure || 0),
      dailyLimit: getImageProviderDailyLimit(provider),
      remaining: Math.max(0, getImageProviderDailyLimit(provider) - Number(record.success || 0)),
      disabledUntil: record.disabledUntil || "",
      lastError: record.lastError || "",
      model: record.model || getImageProviderModelName(provider)
    };
  });
  return {
    date: dayKey,
    path: IMAGE_USAGE_PATH,
    providers: summary
  };
}

function friendlyGeminiImageError(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  if (lower.includes("api key") || lower.includes("permission") || lower.includes("unauthenticated")) {
    return "Gemini не сгенерировал обложку: проверьте GEMINI_API_KEY в .env.";
  }
  if (lower.includes("quota") || lower.includes("rate limit")) {
    return "Gemini не сгенерировал обложку: исчерпана квота или сработал лимит запросов.";
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("not supported"))) {
    return `Gemini не сгенерировал обложку: модель ${GEMINI_IMAGE_MODEL} недоступна для этого ключа.`;
  }
  return text;
}

function friendlyOpenAIImageError(message) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  if (lower.includes("billing hard limit") || lower.includes("billing")) {
    return "OpenAI не сгенерировал обложку: достигнут лимит биллинга проекта. Проверьте лимиты и оплату в OpenAI Platform.";
  }
  if (lower.includes("quota") || lower.includes("insufficient_quota")) {
    return "OpenAI не сгенерировал обложку: не хватает квоты или кредитов на проекте.";
  }
  if (lower.includes("model") && lower.includes("not")) {
    return `OpenAI не сгенерировал обложку: модель ${OPENAI_IMAGE_MODEL} недоступна для этого проекта.`;
  }
  return text;
}

function normalizeCoverSize(value) {
  const match = String(value || "").match(/^(\d{2,4})x(\d{2,4})$/);
  if (!match) return "1008x1792";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  const valid = width % 16 === 0 &&
    height % 16 === 0 &&
    ratio <= 3 &&
    pixels >= 655360 &&
    pixels <= 8294400 &&
    Math.max(width, height) <= 3840;
  return valid ? `${width}x${height}` : "1008x1792";
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/config") {
    const imageProviders = getEnabledImageProviders();
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      storage: getPersistentStorageStatus(),
      coverGenerator: {
        ok: imageProviders.length > 0,
        provider: imageProviders[0] || "",
        requestedProvider: COVER_IMAGE_PROVIDER,
        providerOrder: imageProviders,
        freeModelsOnly: true,
        usage: getImageProviderUsageSummary(),
        model: imageProviders[0] ? getImageProviderModelName(imageProviders[0]) : "",
        size: imageProviders[0] === "gemini" ? `${GEMINI_COVER_ASPECT_RATIO} ${GEMINI_IMAGE_SIZE}` : "9:16 720x1280",
        quality: imageProviders[0] === "gemini" ? GEMINI_IMAGE_SIZE : "free-tier"
      },
      tools: await checkTools()
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/image-usage") {
    sendJson(res, 200, {
      ok: true,
      imageProviders: getEnabledImageProviders(),
      imageProviderUsage: getImageProviderUsageSummary()
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/jobs/latest") {
    const latest = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
    sendJson(res, 200, { job: latest ? publicJob(latest) : null });
    return;
  }

  const downloadMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/download-all$/);
  if (req.method === "GET" && downloadMatch) {
    const job = jobs.get(downloadMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }
    try {
      const zip = await buildJobZip(job);
      sendBuffer(res, 200, zip, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="reels-${job.id}.zip"`
      });
    } catch (error) {
      sendJson(res, 404, { error: error.message });
    }
    return;
  }

  const coverMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/outputs\/(\d+)\/cover$/);
  if (req.method === "POST" && coverMatch) {
    const job = jobs.get(coverMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }
    const outputIndex = Number(coverMatch[2]);
    if (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= (job.outputs || []).length) {
      sendJson(res, 404, { error: "Reel not found" });
      return;
    }

    try {
      const body = await readRequestBody(req);
      const output = job.outputs?.[outputIndex];
      const description = cleanPromptText(body.description || output?.description || generateReelDescription(output));
      if (!description) {
        sendJson(res, 400, { error: "Не удалось собрать описание для этого reel" });
        return;
      }
      const cover = await generateCoverForOutput(job, outputIndex, description, body.settings || {});
      sendJson(res, 200, { cover, job: publicJob(job) });
    } catch (error) {
      log(job, `Не удалось сгенерировать обложку: ${shortError(error)}`);
      await saveJob(job).catch(() => {});
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/jobs/")) {
    const id = pathname.split("/").pop();
    const job = jobs.get(id);
    if (!job) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    const body = await readRequestBody(req);
    const url = String(body.url || "").trim();
    const validation = validateYoutubeUrl(url);
    if (!validation.ok) {
      sendJson(res, 400, { error: validation.error });
      return;
    }
    const job = createJob(url, defaultOptions(body));
    jobs.set(job.id, job);
    await saveJob(job);
    runJob(job);
    sendJson(res, 202, { job: publicJob(job) });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function checkTools() {
  const commands = [
    ["yt-dlp", ["--version"]],
    ["ffmpeg", ["-version"]],
    ["ffprobe", ["-version"]]
  ];
  const entries = await Promise.all(commands.map(async ([name, args]) => {
    try {
      const output = await runCommand(name, args, { cwd: ROOT });
      return [name, { ok: true, version: output.split(/\r?\n/)[0] }];
    } catch (error) {
      return [name, { ok: false, error: error.message }];
    }
  }));
  const tools = Object.fromEntries(entries);
  if (tools.ffmpeg?.ok) {
    tools.ffmpeg.filters = await getFfmpegFilterSupport().catch(() => ({
      subtitles: false,
      drawtext: false
    }));
  }
  tools.captionRenderer = await getCaptionRendererSupport();
  return tools;
}

async function loadJobs() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  const entries = await fsp.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(JOBS_DIR, entry.name, "job.json");
    try {
      const job = JSON.parse(await fsp.readFile(file, "utf8"));
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        job.error = "Задача была остановлена при завершении сервера";
        for (const step of job.steps || []) {
          if (step.status === "running") step.status = "failed";
        }
        await saveJob(job);
      }
      jobs.set(job.id, job);
    } catch {
      // Ignore broken historical job folders.
    }
  }
  await loadPersistentJobs();
}

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await loadJobs();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      const parsed = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      const pathname = decodeURIComponent(parsed.pathname);
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, pathname);
        return;
      }
      await serveStatic(req, res, pathname);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Auto Reels Pipeline: http://${HOST}:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
