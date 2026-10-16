#!/usr/bin/env node
/**
 * Короткий список «рабочих лошадок»: по каждой паре (тир → модели) то, из чего
 * роутер выбирает. Всё остальное из каталога в выборе не участвует, пока сюда не
 * попадёт.
 *
 * Зачем: в «середине» реестра больше пятисот моделей, и выбор по всему каталогу
 * непредсказуем. Короткий список делает решение объяснимым и быстрым, а новый
 * флагман сам в него не влезет, пока вы не решите.
 *
 *   node tools/build-shortlist.mjs          # записать src/core/shortlist.json
 *   node tools/build-shortlist.mjs --check  # только проверить записи по реестру
 *
 * Каждая запись проверяется по реестру: опечатка или исчезнувшая модель — ошибка,
 * а не молча выпавший кандидат.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const registryPath = join(ROOT, "src", "core", "registry.json");

if (!existsSync(registryPath)) {
  console.error("нет src/core/registry.json — сначала node tools/build-registry.mjs");
  process.exit(1);
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));

/**
 * Список ведётся руками. Порядок внутри тира — это приоритет: при равных
 * кошельках роутер берёт того, кто выше.
 */
const SHORTLIST = {
  frontier: [
    {
      model: "kimi-k3",
      purpose: "флагман на подписке Kimi — сильнейшее, что есть без доплаты за токены",
    },
    { model: "gpt-6.1-sol-pro", purpose: "OpenAI-флагман (sol — топ поколения 6.1)" },
    { model: "gpt-6-astra-pro", purpose: "OpenAI Frontier поколения 6" },
    { model: "claude-opus-5.5", purpose: "Anthropic-флагман" },
    { model: "gemini-4-argon", purpose: "Google-флагман, 1M unified, вводная цена" },
    { model: "gemini-3.1-pro-preview", purpose: "Google-флагман, 1M контекста" },
    { model: "grok-4.7", purpose: "xAI-флагман" },
    { model: "muse-wonder", purpose: "Meta-флагман, 1M, мультимодальный агент" },
  ],
  subFrontier: [
    { model: "glm-5.3", purpose: "Z.ai по подписке, 1M — основная рабочая модель" },
    { model: "deepseek-v4-pro", purpose: "DeepSeek по OpenCode Go, 1M" },
    { model: "gpt-5.6-terra", purpose: "GPT-5.6 Terra — Sub-Frontier у OpenAI" },
    { model: "glm-5.2", purpose: "запас, если 5.3 в лимите" },
  ],
  middle: [
    { model: "glm-5.3-flash", purpose: "быстрая рутина, Z.ai/OpenCode Go, 1M" },
    { model: "deepseek-v4.1-flash", purpose: "быстрая рутина, OpenCode Go, 1M" },
    { model: "mimo-v2.6-flash", purpose: "быстрая рутина, OpenCode Go, 1M" },
    { model: "qwen3.8-flash", purpose: "быстрая рутина, OpenCode Go, 1M" },
    { model: "minimax-m3", purpose: "средняя задача с большим контекстом, OpenCode Go" },
    { model: "kimi-k2.7-code", purpose: "кодинг по подписке Kimi" },
    { model: "mimo-v2.6-pro", purpose: "посильнее середины, OpenCode Go" },
    { model: "deepseek-v4-flash-vision-exp", purpose: "рутина с изображениями" },
  ],
  low: [
    { model: "nemotron-3-ultra-free", purpose: "бесплатный, но крупный" },
    { model: "nemotron-3.5-lightning-free", purpose: "бесплатный и быстрый" },
    { model: "mimo-v2.6-flash-free", purpose: "бесплатный, OpenCode Go" },
    { model: "step-5-preview-free", purpose: "бесплатный" },
    { model: "longcat-2.5-preview-free", purpose: "бесплатный, 1M контекста" },
  ],
};

const models = registry.models;
const problems = [];
const tiers = {};

for (const [tier, entries] of Object.entries(SHORTLIST)) {
  tiers[tier] = [];
  for (const entry of entries) {
    const record = models[entry.model];
    if (!record) {
      problems.push(`${tier}: «${entry.model}» нет в реестре`);
      continue;
    }
    const harnesses = Object.keys(record.harnesses);
    if (harnesses.length === 0) {
      problems.push(`${tier}: «${entry.model}» не найден ни в одном харнесе`);
      continue;
    }
    tiers[tier].push({
      model: entry.model,
      purpose: entry.purpose,
      tierInRegistry: record.tier,
      harnesses,
      /** Конкретные id, которые роутер и сравнивает. */
      ids: harnesses.flatMap((h) => record.harnesses[h]),
      /** Харнес (имя метки) → id модели в нём: нужно, чтобы показать пару в UI. */
      idsByHarness: record.harnesses,
    });
  }
}

if (problems.length) {
  console.error("список не собран:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const payload = {
  generatedAt: new Date().toISOString(),
  note: "Порядок внутри тира — приоритет. Правится в tools/build-shortlist.mjs или настройкой shortlist.",
  tiers,
};

console.log(`список собран: ${Object.values(tiers).reduce((n, t) => n + t.length, 0)} записей`);
for (const [tier, entries] of Object.entries(tiers)) {
  console.log(`  ${tier}: ${entries.map((e) => e.model).join(", ")}`);
  for (const e of entries) {
    if (e.tierInRegistry !== tier) {
      console.log(`     ! ${e.model} в реестре ${e.tierInRegistry}, а в списке ${tier} — приоритет у списка`);
    }
  }
}

if (!process.argv.includes("--check")) {
  const out = join(ROOT, "src", "core", "shortlist.json");
  writeFileSync(out, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`\nзаписано: ${out}`);
}
