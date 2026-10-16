#!/usr/bin/env node
/**
 * Собирает реестр моделей: одна каноническая модель → как она называется в
 * каждом харнесе, к какому классу относится и что умеет.
 *
 *   node tools/build-registry.mjs            # записать src/core/registry.json
 *   node tools/build-registry.mjs --markdown # ещё и таблицу в docs/models.md
 *
 * Источники:
 *   - `bb provider models <id> --json` — фактические id и названия в харнесах;
 *   - OpenRouter /api/v1/models — описание, модальности, контекст, авторство.
 *     Оттуда берётся только то, что проверяемо (модальности, контекст), и теги
 *     назначения, разобранные из текста описания самого вендора.
 *
 * Тир здесь НЕ выводится из имени регулярками — это и было источником ошибок.
 * Тир берётся из явного списка классов ниже и правится руками.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const HARNESSES = [
  { provider: "pi", label: "pi" },
  { provider: "acp-omp", label: "omp" },
  { provider: "acp-hermes-agent", label: "hermes" },
  { provider: "acp-opencode", label: "opencode" },
];

/** Префиксы, которыми харнесы указывают кошелёк, а не модель. */
const BILLING_PREFIXES = new Set([
  "openrouter",
  "opencode-go",
  "opencode",
  "kimi-coding",
  "kimi-code",
  "kimi-for-coding-oauth",
  "kimi-oauth",
  "kimi",
  "zai",
  "google",
  "gemini",
  "groq",
  "openai-codex",
  "moonshotai",
]);

/** Канонический префикс имени по семейству. */
const FAMILY_PREFIX = {
  openai: "gpt",
  anthropic: "claude",
  google: "gemini",
  "x-ai": "grok",
  moonshotai: "kimi",
  deepseek: "deepseek",
  "z-ai": "glm",
  qwen: "qwen",
  xiaomi: "mimo",
  minimax: "minimax",
  tencent: "hy",
  stepfun: "step",
  meta: "llama",
  muse: "muse",
  mistralai: "mistral",
  nvidia: "nemotron",
  cohere: "command",
  amazon: "nova",
  inclusionai: "ling",
  "bytedance-seed": "seed",
};

const FAMILY_ALIASES = [
  ["claude", "anthropic"],
  ["anthropic", "anthropic"],
  ["gpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["openai", "openai"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["google", "google"],
  ["deepseek", "deepseek"],
  ["kimi", "moonshotai"],
  ["moonshot", "moonshotai"],
  ["glm", "z-ai"],
  ["z-ai", "z-ai"],
  ["grok", "x-ai"],
  ["x-ai", "x-ai"],
  ["qwen", "qwen"],
  ["mimo", "xiaomi"],
  ["xiaomi", "xiaomi"],
  ["minimax", "minimax"],
  ["hy", "tencent"],
  ["tencent", "tencent"],
  ["step", "stepfun"],
  ["longcat", "longcat"],
  ["llama", "meta"],
  ["meta", "meta"],
  ["muse", "muse"],
  ["mistral", "mistralai"],
  ["mixtral", "mistralai"],
  ["nemotron", "nvidia"],
  ["nvidia", "nvidia"],
  ["command", "cohere"],
  ["nova", "amazon"],
  ["ling", "inclusionai"],
  ["seed", "bytedance-seed"],
  ["sakana", "sakana"],
  ["poolside", "poolside"],
  ["upstage", "upstage"],
];

const COLON_SUFFIXES = new Set(["free", "batch", "exacto", "thinking", "online", "extended"]);

/** Явный класс модели. Frontier — конкретные модели, а не семейства. */
/**
 * Кодовые имена OpenAI задают класс внутри поколения. Владелец линейки:
 * luna — самая слабая, terra — Sub-Frontier, astra — Frontier; sol — топ
 * последнего поколения (6.1 выпущен только им).
 */
const CODENAME_CLASS = [
  [/-luna/, "middle"],
  [/-terra/, "subFrontier"],
  [/-astra/, "frontier"],
  [/-sol/, "frontier"],
];

const FRONTIER_MODELS = [
  "gpt-6.1-sol-pro",
  "gpt-6.1-sol",
  "gpt-6-sol-pro",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6-astra-pro",
  "claude-opus-5.5",
  "claude-opus-5",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-4-argon",
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "kimi-k3",
  "kimi-k3-256k",
  "muse-wonder",
];

const SUB_FRONTIER_MODELS = [
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-opus-4.8",
  "deepseek-v4-pro",
  "deepseek-v4-pro-0813",
  "glm-5.3",
  "glm-5.3-prime",
  "glm-5.2",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "grok-4.3",
  "gpt-5.5-pro",
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-opus-4.8",
];

/** Теги назначения: только те, что подтверждаются текстом описания вендора. */
const STRENGTH_PATTERNS = [
  [/cod(e|ing)|software engineering|programm/i, "код"],
  [/agentic|tool[- ]calling|long[- ]horizon/i, "агентные задачи"],
  [/reason/i, "рассуждения"],
  [/multimodal|vision|image/i, "изображения"],
  [/video/i, "видео"],
  [/math|competition/i, "математика"],
  [/fast|low[- ]latency|high[- ]speed/i, "скорость"],
  [/cheap|economical|cost[- ]effective/i, "дешевизна"],
  [/long[- ]context|1m|million tokens/i, "длинный контекст"],
  [/search|retrieval|rag/i, "поиск и RAG"],
];

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function loadCatalogs() {
  const out = {};
  for (const { provider, label } of HARNESSES) {
    let parsed = [];
    try {
      const json = sh("bb", ["provider", "models", provider, "--json"]);
      const data = JSON.parse(json);
      parsed = (Array.isArray(data) ? data : (data.models ?? [])).map((m) => m.id ?? m.model);
    } catch (error) {
      console.error(`не удалось прочитать каталог ${provider}: ${String(error).slice(0, 120)}`);
      continue;
    }
    out[label] = parsed.filter(Boolean);
  }
  return out;
}

function stripBilling(id) {
  const head = id.includes(":") ? id.slice(0, id.indexOf(":")) : id.split("/")[0];
  if (BILLING_PREFIXES.has(head)) {
    const rest = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id.split("/").slice(1).join("/");
    return rest.split("/").pop() ?? rest;
  }
  return id.split("/").pop() ?? id;
}

function bareName(id) {
  const afterSlash = id.split("/").pop() ?? "";
  const colon = afterSlash.lastIndexOf(":");
  if (colon === -1) return afterSlash;
  const tail = afterSlash.slice(colon + 1);
  return COLON_SUFFIXES.has(tail.toLowerCase()) ? afterSlash.slice(0, colon) : tail;
}

function familyOf(id) {
  const hay = id.replace(/^openrouter:/, "").toLowerCase();
  for (const seg of [bareName(id).toLowerCase(), ...hay.split(/[/:]/).reverse()]) {
    for (const [alias, family] of [...FAMILY_ALIASES].sort((a, b) => b[0].length - a[0].length)) {
      if (seg === alias) return family;
      if (new RegExp(`^${alias}(?=[-.0-9]|$)`).test(seg)) return family;
    }
  }
  return null;
}

/** Канонический ключ: семейство + имя, если имя ещё не начинается с него. */
function canonicalOf(id) {
  const family = familyOf(id);
  const name = bareName(id).toLowerCase();
  const prefix = family ? FAMILY_PREFIX[family] : null;
  if (!prefix) return name;
  return name.startsWith(prefix) ? name : `${prefix}-${name}`;
}

function classOf(canonical) {
  // Явные списки главнее кодовых имён: ими правят конкретные модели.
  if (FRONTIER_MODELS.includes(canonical)) return "frontier";
  if (SUB_FRONTIER_MODELS.includes(canonical)) return "subFrontier";
  for (const [re, tier] of CODENAME_CLASS) {
    if (re.test(canonical)) return tier;
  }
  if (/(:free|-free)$/.test(canonical)) return "low";
  return null; // middle по умолчанию
}

function strengthsFrom(description) {
  if (!description) return [];
  return STRENGTH_PATTERNS.filter(([re]) => re.test(description)).map(([, tag]) => tag);
}

async function loadOpenRouterMeta() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const body = await res.json();
    const map = new Map();
    for (const m of body.data ?? []) {
      const id = m.id ?? "";
      const bare = id.split("/").pop() ?? "";
      for (const key of [id, bare, id.replace("/", "-")]) {
        if (!map.has(key)) map.set(key, m);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

const catalogs = loadCatalogs();
const orMeta = await loadOpenRouterMeta();

/** canonical → запись реестра */
const registry = new Map();

for (const [harness, ids] of Object.entries(catalogs)) {
  for (const id of ids) {
    const canonical = canonicalOf(id);
    if (!canonical) continue;
    let entry = registry.get(canonical);
    if (!entry) {
      entry = {
        canonical,
        family: familyOf(id),
        tier: classOf(canonical) ?? "middle",
        tierSource: classOf(canonical) ? "explicit" : "default",
        harnesses: {},
        contextLength: null,
        modalities: [],
        strengths: [],
        description: null,
      };
      registry.set(canonical, entry);
    }
    (entry.harnesses[harness] ??= []).push(id);
  }
}

// Обогащаем метаданными OpenRouter: точное совпадение сначала, затем по суффиксу.
for (const entry of registry.values()) {
  for (const [harness, ids] of Object.entries(entry.harnesses)) {
    for (const id of ids) {
      const bare = stripBilling(id);
      const meta = orMeta.get(bare) ?? orMeta.get(id.replace(/^openrouter:/, ""));
      if (!meta) continue;
      entry.contextLength ??= meta.context_length ?? null;
      entry.modalities = meta.architecture?.input_modalities ?? entry.modalities;
      entry.strengths = strengthsFrom(meta.description);
      entry.description = (meta.description ?? "").split(/(?<=\.)\s/)[0]?.slice(0, 300) ?? null;
      break;
    }
    if (entry.description) break;
  }
}

const sorted = [...registry.values()].sort(
  (a, b) =>
    ["frontier", "subFrontier", "middle", "low"].indexOf(a.tier) -
      ["frontier", "subFrontier", "middle", "low"].indexOf(b.tier) ||
    a.canonical.localeCompare(b.canonical),
);

const payload = {
  generatedAt: new Date().toISOString(),
  harnesses: HARNESSES.map((h) => h.label),
  tiers: { frontier: FRONTIER_MODELS, subFrontier: SUB_FRONTIER_MODELS },
  models: Object.fromEntries(sorted.map((e) => [e.canonical, e])),
};

const outPath = join(ROOT, "src", "core", "registry.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 1)}\n`);

// Отчёт в stdout: сколько моделей и как они разложены.
const byTier = { frontier: 0, subFrontier: 0, middle: 0, low: 0 };
for (const e of sorted) byTier[e.tier] += 1;
console.log(`реестр: ${sorted.length} канонических моделей → ${outPath}`);
console.log(`по тирам: ${JSON.stringify(byTier)}`);
console.log(`с описанием вендора: ${sorted.filter((e) => e.description).length}`);
console.log("");
console.log("frontier:");
for (const e of sorted.filter((x) => x.tier === "frontier")) {
  const names = Object.entries(e.harnesses).map(([h, ids]) => `${h}:${ids.length}`);
  console.log(`  ${e.canonical.padEnd(34)} ${names.join(" ")}  [${e.strengths.join(", ")}]`);
}

if (process.argv.includes("--markdown")) {
  const lines = [
    "# Доступные модели и их имена в харнесах",
    "",
    `Сгенерировано ${payload.generatedAt}. Не редактировать руками — \`node tools/build-registry.mjs --markdown\`.`,
    "",
    "| Модель | Тир | Контекст | Умеет | pi | omp | hermes | opencode |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const e of sorted) {
    const cell = (h) => (e.harnesses[h] ?? []).map((x) => `\`${x}\``).join("<br>") || "—";
    lines.push(
      `| \`${e.canonical}\` | ${e.tier} | ${
        e.contextLength ? `${Math.round(e.contextLength / 1000)}k` : "—"
      } | ${e.strengths.join(", ") || "—"} | ${cell("pi")} | ${cell("omp")} | ${cell("hermes")} | ${cell(
        "opencode",
      )} |`,
    );
  }
  const docsDir = join(ROOT, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "models.md"), `${lines.join("\n")}\n`);
  console.log(`\nтаблица: ${join(docsDir, "models.md")}`);
}
