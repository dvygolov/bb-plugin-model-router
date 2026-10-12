/**
 * Слой 2 и 3: выбор харнеса и конкретной модели.
 *
 * Чистая функция: на вход задача + каталоги + квоты, на выход решение с причинами.
 * Ничего не создаёт и никуда не ходит — это ядро, которое потом вызывает плагин.
 */

import {
  HARNESSES,
  HARNESSES_UNAVAILABLE,
  hasAll,
  missing,
  type Capability,
  type Funding,
  type Harness,
} from "./capabilities";
import { classify, type TaskSignals } from "./classify";
import {
  DEFAULT_BOUNDARIES,
  TIERS,
  candidatesOfTier,
  detectFamily,
  isSpecializedModel,
  qualityScore,
  resolveTier,
  tierRank,
  type Tier,
  type TierBoundaries,
} from "./tiers";

export interface QuotaState {
  percent: number;
  window?: string;
  resetsAt?: string;
  note?: string;
}

export interface DecideInput {
  task: TaskSignals;
  /** providerId → список id моделей из `bb provider models <p> --json` */
  catalogs: Record<string, string[]>;
  /** Префикс вендора → состояние квоты (из extra-usage и usage-коллектора BB). */
  quotas?: Record<string, QuotaState>;
  boundaries?: TierBoundaries;
  prefs?: {
    forceHarness?: string;
    /** Жёсткий список допустимых харнесов: плагин исключает те, к которым у него нет бриджа. */
    allowedHarnesses?: string[];
    forceTier?: Tier;
    extraCapabilities?: Capability[];
    /** Порядок предпочтения харнесов при равных очках. */
    harnessOrder?: string[];
  };
}

export interface ModelCandidate {
  id: string;
  score: number;
  vendor: string;
  funding: Funding;
  quotaPercent: number | null;
}

export interface HarnessCandidate {
  id: string;
  ok: boolean;
  missingCapabilities: Capability[];
  best?: ModelCandidate;
  score: number;
  why: string;
}

export interface Decision {
  task: string;
  requires: Capability[];
  tier: Tier;
  tierDowngradedFrom: Tier | null;
  harnessId: string;
  modelId: string;
  funding: Funding;
  billingVendor: string;
  harnessCandidates: HarnessCandidate[];
  reasons: string[];
  confidence: "high" | "low";
  alternatives: string[];
}

/** Приоритет источника денег. Больше — предпочтительнее. */
const FUNDING_WEIGHT: Record<Funding, number> = {
  subscription: 100,
  "oauth-plan": 95,
  free: 70,
  "api-key": 40,
  credits: 10,
};

const BILLING_PREFIXES = new Set([
  "openrouter",
  "opencode-go",
  "opencode",
  "kimi-coding",
  "kimi-code",
  "kimi-for-coding-oauth",
  "kimi",
  "zai",
  "google",
  "gemini",
  "groq",
  "openai-codex",
]);

/** Каким вендором оплачивается конкретный id внутри конкретного харнеса. */
export function billingFor(h: Harness, id: string): { vendor: string; funding: Funding } {
  const clean = id.replace(/^openrouter:/, "");
  const first = clean.split("/")[0] ?? "";

  // Особый случай: у Hermes весь каталог помечен openrouter:, но биллинг идёт
  // через его собственный пул кредов (Codex-OAuth для OpenAI, Kimi-OAuth и т.д.).
  if (h.id === "acp-hermes-agent" && (id.startsWith("openrouter:") || first === "openrouter")) {
    const fam = detectFamily(id);
    const via: Record<string, [string, Funding]> = {
      openai: ["openai-codex", "oauth-plan"],
      moonshotai: ["kimi", "oauth-plan"],
      "z-ai": ["zai", "subscription"],
      google: ["google", "api-key"],
    };
    const hit = fam ? via[fam] : undefined;
    if (hit) return { vendor: hit[0], funding: hit[1] };
    return { vendor: "openrouter", funding: "credits" };
  }

  if (BILLING_PREFIXES.has(first)) {
    const known = h.vendors.find((v) => v.prefix === first);
    return { vendor: first, funding: known?.funding ?? "credits" };
  }
  // Префикс не биллинговый (например "google/gemini-3.1-pro" — вендор всё же google).
  const byPrefix = h.vendors.find((v) => clean.startsWith(v.prefix));
  if (byPrefix) return { vendor: byPrefix.prefix, funding: byPrefix.funding };
  return { vendor: first || "unknown", funding: h.vendors.find((v) => v.funding === "credits")?.funding ?? "credits" };
}

function quotaOf(quotas: Record<string, QuotaState>, vendor: string): QuotaState | undefined {
  return quotas[vendor];
}

/** Очки кандидата: источник денег − штраф за близость к лимиту + бонус за «родной» тир. */
function scoreModel(
  h: Harness,
  id: string,
  quotas: Record<string, QuotaState>,
  tier: Tier,
): ModelCandidate {
  const { vendor, funding } = billingFor(h, id);
  const q = quotaOf(quotas, vendor);
  const pct = q ? q.percent : null;
  let score = FUNDING_WEIGHT[funding];
  if (pct !== null) score -= pct * 0.9; // при 100% подписка уходит ниже credits
  score += qualityScore(id) * 0.5;
  // Модель, случайно попавшая в тир из-за понижающего маркера (gpt-5.4-mini в
  // Sub-Frontier), не должна обгонять родную модель тира (kimi-k3).
  const t = resolveTier(id);
  if (!t.reasons.some((r) => r.kind === "demote")) score += 8;
  else score -= 4;
  return { id, score, vendor, funding, quotaPercent: pct, };
}

/** Лучшая модель нужного тира у конкретного харнеса. */
export function bestModelForTier(
  h: Harness,
  tier: Tier,
  catalogs: Record<string, string[]>,
  quotas: Record<string, QuotaState>,
  boundaries: TierBoundaries,
): ModelCandidate | undefined {
  const ids = catalogs[h.id] ?? [];
  const candidates = ids
    .filter((id) => !id.includes(":batch")) // off-peak дешев, но медленнее — по умолчанию не берём
    .filter((id) => !isSpecializedModel(id))
    .filter((id) => resolveTier(id, boundaries).tier === tier)
    .map((id) => scoreModel(h, id, quotas, tier))
    .sort((a, b) => b.score - a.score);
  return candidates.find((c) => c.quotaPercent === null || c.quotaPercent < 100) ?? candidates[0];
}

export function decide(input: DecideInput): Decision {
  const boundaries = input.boundaries ?? DEFAULT_BOUNDARIES;
  const quotas = input.quotas ?? {};
  const prefs = input.prefs ?? {};
  const cls = classify(input.task);
  const reasons: string[] = [];

  if (prefs.extraCapabilities?.length) {
    cls.requires = [...new Set([...cls.requires, ...prefs.extraCapabilities])];
    reasons.push(`Судья добавил требования: ${prefs.extraCapabilities.join(", ")}`);
  }
  if (prefs.forceTier) {
    reasons.push(`Тир задан извне (судья или пикер): ${prefs.forceTier}`);
  }
  const wantedTier: Tier = prefs.forceTier ?? cls.tier;

  reasons.push(
    `Возможности: ${cls.requires.length ? cls.requires.join(", ") : "базовые (BB-инструменты)"}`,
  );

  const pool = HARNESSES.filter(
    (h) =>
      !HARNESSES_UNAVAILABLE.includes(h.id) &&
      (!prefs.allowedHarnesses || prefs.allowedHarnesses.includes(h.id)),
  );
  if (prefs.forceHarness) reasons.push(`Харнес задан вручную: ${prefs.forceHarness}`);

  const harnessCandidates: HarnessCandidate[] = pool.map((h) => {
    const miss = missing(h, cls.requires);
    const ok = miss.length === 0 && (!prefs.forceHarness || h.id === prefs.forceHarness);
    const best = ok ? bestModelForTier(h, wantedTier, input.catalogs, quotas, boundaries) : undefined;
    let score = best ? best.score : -1;
    if (!ok) score = -1;
    else score -= h.tieBreak * 1.5;
    return {
      id: h.id,
      ok: ok && Boolean(best),
      missingCapabilities: miss,
      best,
      score,
      why: miss.length
        ? `не умеет: ${miss.join(", ")}`
        : best
          ? `может; лучший вариант тира ${cls.tier}: ${best.vendor} (${best.funding})`
          : `не нашлось модели тира ${wantedTier} в каталоге`,
    };
  });

  const ordered = [...harnessCandidates].sort((a, b) => b.score - a.score);
  let chosen = ordered.find((c) => c.ok) ?? null;
  let tier: Tier = wantedTier;
  let downgradedFrom: Tier | null = null;

  // Ничего не нашлось в нужном тире — спускаемся на тир ниже.
  if (!chosen) {
    for (let i = tierRank(wantedTier) - 1; i >= 0; i--) {
      const t = TIERS[i] as Tier;
      const retry = pool
        .filter((h) => hasAll(h, cls.requires) && (!prefs.forceHarness || h.id === prefs.forceHarness))
        .map((h) => {
          const best = bestModelForTier(h, t, input.catalogs, quotas, boundaries);
          return best ? { h, best, score: best.score - h.tieBreak * 1.5 } : null;
        })
        .filter((x): x is { h: Harness; best: ModelCandidate; score: number } => x !== null)
        .sort((a, b) => b.score - a.score);
      if (retry.length) {
        chosen = {
          id: retry[0].h.id,
          ok: true,
          missingCapabilities: [],
          best: retry[0].best,
          score: retry[0].score,
          why: `тир ${wantedTier} недоступен, спуск до ${t}`,
        };
        downgradedFrom = wantedTier;
        tier = t;
        reasons.push(`Ни в одном харнесе нет модели тира ${wantedTier} — спуск до ${t}`);
        break;
      }
    }
  }

  if (!chosen || !chosen.best) {
    throw new Error(
      "Не удалось подобрать модель: под требуемые возможности нет ни одного доступного кандидата",
    );
  }

  reasons.push(
    `Тир: ${tier}${downgradedFrom ? ` (спуск с ${downgradedFrom})` : ""} — ${
      cls.reasons.find((r) => r.tier)?.note ?? "—"
    }`,
  );
  reasons.push(
    `Харнес: ${chosen.id} — ${chosen.why}, перевес над следующим: ${
      Math.round((chosen.score - (ordered.find((c) => c.ok && c.id !== chosen!.id)?.score ?? 0)) * 10) / 10
    }`,
  );

  const alternatives = (input.catalogs[chosen.id] ?? [])
    .filter((id) => resolveTier(id, boundaries).tier === tier && id !== chosen!.best!.id)
    .filter((id) => !isSpecializedModel(id) && !id.includes(":batch"))
    .map((id) => ({ id, s: qualityScore(id) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((x) => x.id);

  return {
    task: input.task.text,
    requires: cls.requires,
    tier,
    tierDowngradedFrom: downgradedFrom,
    harnessId: chosen.id,
    modelId: chosen.best.id,
    funding: chosen.best.funding,
    billingVendor: chosen.best.vendor,
    harnessCandidates: ordered,
    reasons,
    confidence: cls.confidence,
    alternatives,
  };
}

/** Короткая сводка для CLI и журнала. */
export function summarize(d: Decision): string {
  const lines = [
    `задача: ${d.task.slice(0, 90)}${d.task.length > 90 ? "…" : ""}`,
    `харнес: ${d.harnessId}`,
    `модель: ${d.modelId}`,
    `тир:    ${d.tier}${d.tierDowngradedFrom ? ` (спуск с ${d.tierDowngradedFrom})` : ""}`,
    `платит: ${d.billingVendor} (${d.funding})`,
    `уверенность: ${d.confidence}`,
    "причины:",
    ...d.reasons.map((r) => `  - ${r}`),
  ];
  if (d.alternatives.length) lines.push(`альтернативы: ${d.alternatives.join(", ")}`);
  return lines.join("\n");
}

export { candidatesOfTier, resolveTier };
