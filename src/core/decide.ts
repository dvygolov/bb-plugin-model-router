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
    /**
     * Что должно уметь читать на входе: "image", "audio", "video".
     * Если задача принесла картинку, текстовая модель не подходит, даже если
     * она сильнее и дешевле.
     */
    requiredModalities?: string[];
    /** Модальности модели по реестру. null — данных нет. */
    modalitiesOf?: (id: string) => string[] | null;
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
  /** Модальности не подтверждены реестром — выбран аварийно. */
  modalitiesUnconfirmed?: boolean;
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
  requiredModalities: string[] = [],
  modalitiesOf?: (id: string) => string[] | null,
  out?: { allExhausted?: boolean },
): ModelCandidate | undefined {
  const ids = catalogs[h.id] ?? [];
  let eligible = ids
    .filter((id) => !id.includes(":batch")) // off-peak дешев, но медленнее — по умолчанию не берём
    .filter((id) => !isSpecializedModel(id))
    .filter((id) => resolveTier(id, boundaries).tier === tier);

  // Модальности важнее тира: модель, которая не читает картинку, не подходит для
  // задачи с картинкой. Сначала строгая проверка, и только если она не оставила
  // никого — разрешаем модели с неизвестными модальностями (и признаёмся в этом).
  let modalitiesUnconfirmed = false;
  if (requiredModalities.length > 0 && modalitiesOf) {
    const fits = (id: string, allowUnknown: boolean): boolean => {
      const mods = modalitiesOf(id);
      if (mods === null) return allowUnknown;
      return requiredModalities.every((m) => mods.includes(m));
    };
    const strict = eligible.filter((id) => fits(id, false));
    if (strict.length > 0) {
      eligible = strict;
    } else {
      eligible = eligible.filter((id) => fits(id, true));
      modalitiesUnconfirmed = true;
    }
  }

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
    .map((c) => ({ ...c, viaShortlist, modalitiesUnconfirmed }))
    .sort((a, b) => b.score - a.score);
  const live = candidates.find((c) => c.quotaPercent === null || c.quotaPercent < 100);
  if (!live && candidates.length > 0) {
    // Все кандидаты упираются в исчерпанную подписку. Молча взять исчерпанного —
    // значит гарантированно уронить тред (так и случилось с opencode-go).
    // Лучше не предлагать этот тир вовсе: вызывающий спустится ниже.
    if (out) out.allExhausted = true;
  }
  return live;
}

export function decide(input: DecideInput): Decision {
  const boundaries = input.boundaries ?? DEFAULT_BOUNDARIES;
  const quotas = input.quotas ?? {};
  const prefs = input.prefs ?? {};
  const blocked = new Set(prefs.blockedVendors ?? []);
  const modalities = prefs.requiredModalities ?? [];
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
  if (prefs.forceTier) reasons.push(`Тир задан извне (судья или пикер): ${prefs.forceTier}`);
  const wantedTier: Tier = prefs.forceTier ?? cls.tier;

  const pool = HARNESSES.filter(
    (h) =>
      !HARNESSES_UNAVAILABLE.includes(h.id) &&
      (!prefs.allowedHarnesses || prefs.allowedHarnesses.includes(h.id)),
  );
  if (prefs.forceHarness) reasons.push(`Харнес задан вручную: ${prefs.forceHarness}`);

  interface Attempt {
    chosen: HarnessCandidate | null;
    ordered: HarnessCandidate[];
    tier: Tier;
    downgradedFrom: Tier | null;
    exhausted: boolean;
  }

  /** Одна попытка: под этот набор требований и этот тир. */
  const attempt = (requires: Capability[], wantsTier: Tier): Attempt => {
    let exhausted = false;
    const list: HarnessCandidate[] = pool.map((h) => {
      const miss = missing(h, requires);
      const ok = miss.length === 0 && (!prefs.forceHarness || h.id === prefs.forceHarness);
      const exhaust = { allExhausted: false };
      const best = ok
        ? bestModelForTier(
            h,
            wantsTier,
            input.catalogs,
            quotas,
            boundaries,
            blocked,
            allowedFor(wantsTier),
            modalities,
            prefs.modalitiesOf,
            exhaust,
          )
        : undefined;
      if (exhaust.allExhausted) exhausted = true;
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
            ? `может; лучший вариант тира ${wantsTier}: ${best.vendor} (${best.funding})`
            : `не нашлось модели тира ${wantsTier} в каталоге`,
      };
    });

    const ordered = [...list].sort((a, b) => b.score - a.score);
    let chosen = ordered.find((c) => c.ok) ?? null;
    let tier: Tier = wantsTier;
    let downgradedFrom: Tier | null = null;

    if (!chosen) {
      for (let i = tierRank(wantsTier) - 1; i >= 0; i--) {
        const t = TIERS[i] as Tier;
        const retry = pool
          .filter((h) => hasAll(h, requires) && (!prefs.forceHarness || h.id === prefs.forceHarness))
          .map((h) => {
            const best = bestModelForTier(
              h,
              t,
              input.catalogs,
              quotas,
              boundaries,
              blocked,
              allowedFor(t),
              modalities,
              prefs.modalitiesOf,
            );
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
            why: `тир ${wantsTier} недоступен, спуск до ${t}`,
          };
          downgradedFrom = wantsTier;
          tier = t;
          reasons.push(`Ни в одном харнесе нет доступной модели тира ${wantsTier} — спуск до ${t}`);
          break;
        }
      }
    }

    return { chosen, ordered, tier, downgradedFrom, exhausted };
  };

  /**
   * Требования ослабляются по одному, а не отклоняются целиком.
   * Классификатор легко просит невозможное — например «скриншот» тянул
   * computerUse, а картинка — vision, и ни один харнес не умеет и то и другое.
   * Отказать в работе хуже, чем выполнить её чуть менее подходящим агентом.
   */
  const SOFT_GROUPS: Capability[][] = [
    ["computerUse"],
    ["browser", "browserOwnProfile", "web", "messaging", "cron", "delegation", "lsp"],
    ["vision"],
    ["codeEdit"],
  ];
  const levels: { label: string; requires: Capability[] }[] = [
    { label: "как просили", requires: cls.requires },
  ];
  let working: Capability[] = cls.requires;
  for (const group of SOFT_GROUPS) {
    const next = working.filter((c) => !group.includes(c));
    if (next.length === working.length) continue;
    working = next;
    levels.push({ label: `без ${group.join(", ")}`, requires: next });
  }

  let usedLevel: { label: string; requires: Capability[] } = levels[0]!;
  let result = attempt(cls.requires, wantedTier);
  if (!result.chosen) {
    for (const level of levels.slice(1)) {
      const retry = attempt(level.requires, wantedTier);
      if (retry.chosen) {
        result = retry;
        usedLevel = level;
        reasons.push(
          `Требования ослаблены (${level.label}): харнеса, умеющего всё сразу, нет`,
        );
        break;
      }
    }
  }

  if (result.chosen && result.exhausted && !result.downgradedFrom) {
    reasons.push("В этом тире часть кандидатов упирается в исчерпанные подписки");
  }

  // Какие требования реально легли в решение — это видно в причинах.
  const appliedRequires = result.chosen ? usedLevel.requires : cls.requires;
  reasons.push(
    `Возможности: ${
      appliedRequires.length ? appliedRequires.join(", ") : "базовые (BB-инструменты)"
    }`,
  );

  // Последний рубеж: требования выполнить не удалось ничем. Работать всё равно
  // надо — берём лучшего доступного и говорим об этом прямо.
  if (!result.chosen) {
    const fallback: { h: Harness; best: ModelCandidate; score: number }[] = [];
    for (const h of pool) {
      for (const id of input.catalogs[h.id] ?? []) {
        if (id.includes(":batch") || isSpecializedModel(id)) continue;
        const candidate = scoreModel(h, id, quotas, wantedTier);
        if (blocked.has(candidate.vendor)) continue;
        fallback.push({ h, best: candidate, score: candidate.score - h.tieBreak * 1.5 });
      }
    }
    fallback.sort((a, b) => b.score - a.score);
    const live = fallback.find((x) => x.best.quotaPercent === null || x.best.quotaPercent < 100);
    const pick = live ?? fallback[0];
    if (!pick) {
      throw new Error("Ни один харнес не доступен: проверьте настройки плагина model-router");
    }
    reasons.push(
      "Ни один харнес не выполняет требования задачи — взят лучший доступный вариант",
    );
    result = {
      chosen: {
        id: pick.h.id,
        ok: true,
        missingCapabilities: [],
        best: pick.best,
        score: pick.score,
        why: "аварийный выбор: требования невыполнимы",
      },
      ordered: [],
      tier: resolveTier(pick.best.id, boundaries).tier,
      downgradedFrom: null,
      exhausted: false,
    };
  }

  const chosen = result.chosen;
  if (!chosen || !chosen.best) {
    throw new Error("Не удалось подобрать модель");
  }
  const tier = result.tier;
  const downgradedFrom = result.downgradedFrom;

  reasons.push(
    `Тир: ${tier}${downgradedFrom ? ` (спуск с ${downgradedFrom})` : ""} — ${
      cls.reasons.find((r) => r.tier)?.note ?? "—"
    }`,
  );
  if (modalities.length) {
    reasons.push(
      `Требуются модальности: ${modalities.join(", ")}${
        chosen.best.modalitiesUnconfirmed
          ? " (подтвердить не удалось — выбран из тех, у кого модальности неизвестны)"
          : ""
      }`,
    );
  }
  reasons.push(
    chosen.best.viaShortlist
      ? "Модель взята из короткого списка рабочих лошадок"
      : "Короткий список не дал кандидата — выбор по всему каталогу",
  );
  reasons.push(
    `Харнес: ${chosen.id} — ${chosen.why}, перевес над следующим: ${
      Math.round(
        (chosen.score - (result.ordered.find((c) => c.ok && c.id !== chosen.id)?.score ?? 0)) * 10,
      ) / 10
    }`,
  );

  const alternatives = (input.catalogs[chosen.id] ?? [])
    .filter((id) => resolveTier(id, boundaries).tier === tier && id !== chosen.best!.id)
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
    harnessCandidates: result.ordered,
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
