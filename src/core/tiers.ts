/**
 * Четыре тира: правило, а не список.
 *
 * По одному вендору разметить нельзя: claude-haiku-5.5 и claude-opus-5.5 — оба
 * Anthropic, но это разные тиры; gpt-oss-20b формально OpenAI, но не Frontier.
 * Поэтому тир = семейство модели, скорректированное маркерами класса.
 *
 *   tier = tier(семейство) − 1, если в имени -mini/-flash/-lite/... /:free
 *
 * Границы семейств — настройка (frontierFamilies / subFrontierFamilies ниже).
 */

export const TIERS = ["low", "middle", "subFrontier", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

export const tierRank = (t: Tier): number => TIERS.indexOf(t);

/** Семейства моделей: алиас имени в сегменте id → семья. Проверяются от длинных к коротким. */
const ALIASES: [string, string][] = [
  ["claude", "anthropic"],
  ["anthropic", "anthropic"],
  ["gpt", "openai"],
  ["openai", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
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
  ["mistral", "mistralai"],
  ["mixtral", "mistralai"],
  ["voxtral", "mistralai"],
  ["nemotron", "nvidia"],
  ["nvidia", "nvidia"],
  ["command", "cohere"],
  ["cohere", "cohere"],
  ["nova", "amazon"],
  ["amazon", "amazon"],
  ["ling", "inclusionai"],
  ["inclusion", "inclusionai"],
  ["seed", "bytedance-seed"],
  ["sakana", "sakana"],
  ["poolside", "poolside"],
  ["upstage", "upstage"],
  ["aion", "aion-labs"],
  ["thinkingmachines", "thinkingmachines"],
];

export interface TierBoundaries {
  frontierFamilies: string[];
  subFrontierFamilies: string[];
  middleFamilies: string[];
}

/**
 * Границы по умолчанию — выбор владельца: Frontier это OpenAI, Anthropic, Gemini и Grok.
 * Китайские флагманы (Kimi, DeepSeek, GLM) — Sub-Frontier.
 */
export const DEFAULT_BOUNDARIES: TierBoundaries = {
  frontierFamilies: ["openai", "anthropic", "google", "x-ai"],
  subFrontierFamilies: ["moonshotai", "deepseek", "z-ai"],
  middleFamilies: [
    "minimax",
    "xiaomi",
    "qwen",
    "tencent",
    "stepfun",
    "longcat",
    "meta",
    "mistralai",
    "nvidia",
    "cohere",
    "amazon",
    "inclusionai",
    "bytedance-seed",
    "upstage",
    "sakana",
    "poolside",
    "aion-labs",
    "thinkingmachines",
  ],
};

/**
 * Порог «текущего флагмана» по версии, для каждого Frontier-семейства.
 * У OpenAI и Anthropic Frontier — это только самые свежие модели: o3, o4-mini и
 * gpt-oss — формально OpenAI, но не флагманы. Владелец сформулировал это как
 * «у OpenAI и Anthropic только те модели, которые сейчас там самые крутые».
 * Правится в настройках плагина, чтобы не устаревать вместе с каталогом.
 */
export const DEFAULT_FRONTIER_FLOOR: Record<string, number> = {
  openai: 6,
  anthropic: 5,
  google: 3,
  "x-ai": 4,
};

/** Маркеры, понижающие тир на один шаг. Голова списка — частая причина понижения. */
const DEMOTE_MARKERS = [
  "mini", "flash", "lite", "lightning", "highspeed", "turbo", "small", "nano",
  "haiku",
  "instant", "oss", "gemma", "edge", "tiny", "sr", "free", "batch",
  "8b", "12b", "20b", "24b", "26b", "27b", "31b", "70b", "120b", "a4b", "a12b",
];

/** Маркеры, которые не понижают, даже если рядом есть другие слова. */
const PROMOTE_MARKERS = ["pro", "max", "opus", "ultra", "prime", "thinking", "550b", "2.4t"];

export type TierReasonKind = "family" | "floor" | "demote" | "promote" | "unknown";

export interface TierReason {
  kind: TierReasonKind;
  marker: string;
  detail: string;
}

export interface TierResolution {
  tier: Tier;
  family: string | null;
  reasons: TierReason[];
}

/** Последний сегмент id — имя модели. Хвосты вида :batch/:free учитываются отдельно. */
export function modelName(id: string): { name: string; suffix: string | null } {
  const clean = id.replace(/^openrouter:/, "");
  const parts = clean.split("/");
  const last = parts[parts.length - 1] ?? "";
  const [name, suffix] = last.split(":") as [string, string | undefined];
  return { name, suffix: suffix ?? null };
}

export function detectFamily(id: string): string | null {
  const clean = id.replace(/^openrouter:/, "");
  const segs = clean.split("/");
  const { name } = modelName(id);
  const sorted = [...ALIASES].sort((a, b) => b[0].length - a[0].length);
  const test = (seg: string): string | null => {
    const s = seg.toLowerCase();
    for (const [alias, family] of sorted) {
      if (s === alias) return family;
      const re = new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[-.0-9]|$)`);
      if (re.test(s)) return family;
    }
    return null;
  };
  // Сначала имя модели, затем префиксы справа налево: "kimi-coding/k3", "groq/qwen/qwen3.8-27b".
  for (const seg of [name, ...segs.slice(0, -1).reverse()]) {
    const hit = test(seg);
    if (hit) return hit;
  }
  return null;
}

function baseTierFor(family: string | null, b: TierBoundaries): Tier | null {
  if (!family) return null;
  if (b.frontierFamilies.includes(family)) return "frontier";
  if (b.subFrontierFamilies.includes(family)) return "subFrontier";
  if (b.middleFamilies.includes(family)) return "middle";
  return null; // неизвестное семейство → low
}

/** Чистим размеры (86m, 27b), годы и даты-хвосты (0905) — это не версии. */
function cleanName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?[bmk](?![a-z])/g, "")
    .replace(/(?:19|20)\d{2}/g, "")
    .replace(/0\d{3}/g, "")
    .replace(/-\d{1,2}-\d{1,2}$/, "")
    .replace(/[-_]\d{1,2}$/, "");
}

/** Старшая «настоящая» версия в имени: k3 → 3, glm-5.3 → 5.3, o3-mini → 3. */
export function nameVersion(name: string): number | null {
  const versions = (cleanName(name).match(/\d+(?:\.\d+)?/g) ?? [])
    .filter((v) => !/^0/.test(v))
    .map(Number)
    .filter((n) => Number.isFinite(n) && n < 100);
  return versions.length ? Math.max(...versions) : null;
}

export function resolveTier(
  id: string,
  boundaries: TierBoundaries = DEFAULT_BOUNDARIES,
  floor: Record<string, number> = DEFAULT_FRONTIER_FLOOR,
): TierResolution {
  const { name, suffix } = modelName(id);
  const hay = name.toLowerCase();
  const family = detectFamily(id);
  const reasons: TierReason[] = [];

  let tier = baseTierFor(family, boundaries);
  if (tier === null) {
    tier = "low";
    reasons.push({
      kind: "unknown",
      marker: family ?? "семейство не распознано",
      detail: "семейство не в списках тиров → Low",
    });
  } else {
    reasons.push({
      kind: "family",
      marker: family as string,
      detail: `семейство ${family} → ${tier}`,
    });
  }

  const steps: { kind: TierReasonKind; marker: string; detail: string }[] = [];

  // 1. Порог флагмана: Frontier-семейство, но модель не текущего поколения.
  if (family && tier === "frontier") {
    const min = floor[family] ?? 0;
    const v = nameVersion(name);
    if (v === null || v < min) {
      steps.push({
        kind: "floor",
        marker: `${family} ≥ ${min}`,
        detail: `не текущий флагман семейства (версия ${v ?? "?"} < ${min})`,
      });
    }
  }

  // 2. Маркер класса: -mini, -flash, -haiku, :free …
  const markers: string[] = [...hay.split(/[-_.]/), ...(suffix ? [suffix] : [])];
  const promote = markers.find((m) => PROMOTE_MARKERS.includes(m));
  const demote = markers.find((m) => DEMOTE_MARKERS.includes(m));
  if (demote && !promote) {
    steps.push({ kind: "demote", marker: demote, detail: `маркер «${demote}»` });
  } else if (demote && promote) {
    reasons.push({
      kind: "promote",
      marker: `${promote} против ${demote}`,
      detail: "маркер силы перевешивает маркер класса, понижения по маркеру нет",
    });
  } else if (promote) {
    reasons.push({
      kind: "promote",
      marker: promote,
      detail: `маркер «${promote}» удерживает тир`,
    });
  }

  for (const step of steps) {
    const before = tier;
    tier = TIERS[Math.max(0, tierRank(tier) - 1)] as Tier;
    reasons.push({ ...step, detail: `${step.detail} понижает ${before} → ${tier}` });
  }

  return { tier, family, reasons };
}

/** Оценка «силы» внутри тира: версия + маркеры. Для выбора лучшей модели тира. */
export function qualityScore(id: string): number {
  const { name } = modelName(id);
  const hay = cleanName(name);
  let score = 0;
  const v = nameVersion(name);
  if (v !== null) score += v * 2;
  if (hay.includes("pro")) score += 2;
  if (hay.includes("max")) score += 2;
  if (hay.includes("opus")) score += 2;
  if (hay.includes("prime")) score += 1.5;
  if (hay.includes("ultra")) score += 1.5;
  if (hay.includes("thinking")) score += 1;
  if (hay.includes("batch")) score -= 1;
  if (hay.includes("free")) score -= 0.5;
  return score;
}

export function candidatesOfTier(
  ids: string[],
  tier: Tier,
  boundaries: TierBoundaries = DEFAULT_BOUNDARIES,
): { id: string; score: number; reasons: TierReason[] }[] {
  return ids
    .map((id) => {
      const r = resolveTier(id, boundaries);
      return { id, score: qualityScore(id), reasons: r.reasons, tier: r.tier };
    })
    .filter((x) => x.tier === tier)
    .sort((a, b) => b.score - a.score)
    .map(({ tier: _t, ...rest }) => rest);
}

/**
 * Специализированные модели, которые не годятся как универсальный агент:
 * охрана промптов, модерация, эмбеддинги, речь, картинки, генерация медиа.
 * Из выбора исключаются, если пользователь не попросил их явно.
 */
const SPECIALIZED = /(guard|safeguard|moderation|embed|rerank|whisper|tts|speech|audio|voice|image|imagen|video|veo|banana|diffusion|upscal|ocr|translate-only|nano|codex-mini|deep-research|computer-use|search-preview|realtime|live-preview|safety)/;

export function isSpecializedModel(id: string): boolean {
  const { name } = modelName(id);
  return SPECIALIZED.test(name.toLowerCase());
}
