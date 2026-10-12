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
    /** Вендоры с мёртвыми кредами: не предлагать, пока не починят. */
    blockedVendors?: string[];
    /**
     * Короткий список «рабочих лошадок»: конкретные id по тирам. Если для тира
     * список задан и даёт хоть одного кандидата — выбор идёт только по нему.
     * Всё остальное из каталога не участвует.
     */
    shortlist?: Partial<Record<Tier, string[]>>;
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
  /** Кандидат попал в выбор из короткого списка, а не из всего каталога. */
  viaShortlist: boolean;
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
  "kimi-oauth",
  "moonshotai",
  "gemini",
]);

/**
 * Каким вендором оплачивается конкретный id внутри конкретного харнеса.
 *
 * У Hermes вендор зашит в сам id явным префиксом — `openai-codex:gpt-5.5` (подписка
 * ChatGPT) против `openrouter:openai/gpt-5.5` (кредиты). По семейству модели
 * угадывать нельзя: это давало «платит openai-codex» для OpenRouter-модели.
 */
export function billingFor(h: Harness, id: string): { vendor: string; funding: Funding } {
  // Вендор — первый сегмент id. Двоеточие отделяет его, только если стоит раньше
  // слэша: иначе это суффикс вида ":batch". Срезать префикс нельзя: в
  // "openrouter:moonshotai/kimi-k3" вендор именно openrouter, а не moonshotai.
  const colon = id.indexOf(":");
  const slash = id.indexOf("/");
  const head =
    colon !== -1 && (slash === -1 || colon < slash) ? id.slice(0, colon) : id.split("/")[0] ?? "";
  const known = h.vendors.find((v) => v.prefix === head);
  if (known) return { vendor: head, funding: known.funding };
  if (BILLING_PREFIXES.has(head)) {
    return { vendor: head, funding: head === "openrouter" ? "credits" : "api-key" };
  }
  const byPrefix = h.vendors.find((v) => id.replace(/^openrouter:/, "").startsWith(v.prefix));
  if (byPrefix) return { vendor: byPrefix.prefix, funding: byPrefix.funding };
  return { vendor: head || "unknown", funding: "credits" };
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
  return { id, score, vendor, funding, quotaPercent: pct, viaShortlist: false };
}

/** Лучшая модель нужного тира у конкретного харнеса. */
export function bestModelForTier(
  h: Harness,
  tier: Tier,
  catalogs: Record<string, string[]>,
  quotas: Record<string, QuotaState>,
  boundaries: TierBoundaries,
  blocked: Set<string> = new Set(),
  allowed: Set<string> | null = null,
): ModelCandidate | undefined {
  const ids = catalogs[h.id] ?? [];
  const eligible = ids
    .filter((id) => !id.includes(":batch")) // off-peak дешев, но медленнее — по умолчанию не берём
    .filter((id) => !isSpecializedModel(id))
    .filter((id) => resolveTier(id, boundaries).tier === tier);

  // Короткий список сужает выбор; если для тира он пуст — берём весь каталог.
  let pool = eligible;
  let viaShortlist = false;
  if (allowed && allowed.size > 0) {
    const restricted = eligible.filter((id) => allowed.has(id));
    if (restricted.length > 0) {
      pool = restricted;
      viaShortlist = true;
    }
  }

  const candidates = pool
    .map((id) => scoreModel(h, id, quotas, tier))
    .filter((c) => !blocked.has(c.vendor))
    .map((c) => ({ ...c, viaShortlist }))
    .sort((a, b) => b.score - a.score);
  return candidates.find((c) => c.quotaPercent === null || c.quotaPercent < 100) ?? candidates[0];
}

export function decide(input: DecideInput): Decision {
  const boundaries = input.boundaries ?? DEFAULT_BOUNDARIES;
  const quotas = input.quotas ?? {};
  const prefs = input.prefs ?? {};
  const blocked = new Set(prefs.blockedVendors ?? []);
  const allowedFor = (t: Tier): Set<string> | null => {
    const list = prefs.shortlist?.[t];
    return list && list.length > 0 ? new Set(list) : null;
  };
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
    const best = ok
      ? bestModelForTier(h, wantedTier, input.catalogs, quotas, boundaries, blocked, allowedFor(wantedTier))
      : undefined;
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
          const best = bestModelForTier(h, t, input.catalogs, quotas, boundaries, blocked, allowedFor(t));
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
    chosen.best.viaShortlist
      ? "Модель взята из короткого списка рабочих лошадок"
      : "Короткий список не дал кандидата — выбор по всему каталогу",
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
