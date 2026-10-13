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
  /** Худшее окно вендора: по нему видно, упёрся ли лимит. */
  percent: number;
  /** Имя этого окна — «5 hours», «Weekly», «Monthly», «Credits». */
  window?: string;
  resetsAt?: string;
  /** Все окна вендора: лимитов у него несколько, и любой может упереться. */
  windows?: { label: string; percent: number; resetsAt?: string }[];
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

/**
 * Цена источника денег, в условных единицах штрафа. Меньше — лучше.
 * Подписка не тратит деньги за токен, поэтому идёт первой и даже на соседнем тире
 * обходит кредиты. Бесплатная модель хороша, но слабее: за два тира от нужного
 * она кредитам уже не конкурент, чтобы не отдавать сложную задачу слабаку.
 */
const FUNDING_COST: Record<Funding, number> = {
  subscription: 0,
  "oauth-plan": 0,
  free: 1.2,
  "api-key": 1.5,
  credits: 2,
};

/** Штраф за каждый тир в стороне от запрошенного. */
const TIER_DISTANCE_COST = 1;

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
  const wantedRank = tierRank(wantedTier);

  const pool = HARNESSES.filter(
    (h) =>
      !HARNESSES_UNAVAILABLE.includes(h.id) &&
      (!prefs.allowedHarnesses || prefs.allowedHarnesses.includes(h.id)),
  );
  if (prefs.forceHarness) reasons.push(`Харнес задан вручную: ${prefs.forceHarness}`);

  interface Pick {
    harness: Harness;
    candidate: ModelCandidate;
    tier: Tier;
    distance: number;
  }

  interface Scan {
    pick: Pick | null;
    /** Сколько кандидатов отсечено на каждом шаге — для объяснения. */
    dropped: { noCapability: number; modality: number; deadVendor: number; shortlist: number };
    /** У кого-то из кандидатов нужного тира всё исчерпано. */
    exhausted: boolean;
  }

  /**
   * Один проход по всему каталогу под заданный набор требований.
   *
   * Порядок ровно такой, как задумано: сначала выкидываем вендоров, у которых
   * нет лимита, потом смотрим модальности и тир, и лишь затем — кто платит.
   * Тир при этом не догма: подписка на соседнем тире лучше, чем кредиты на этом.
   */
  const scan = (requires: Capability[]): Scan => {
    const dropped = { noCapability: 0, modality: 0, deadVendor: 0, shortlist: 0 };
    let exhausted = false;
    const picks: Pick[] = [];

    for (const harness of pool) {
      if (prefs.forceHarness && harness.id !== prefs.forceHarness) continue;
      if (!hasAll(harness, requires)) {
        dropped.noCapability += 1;
        continue;
      }
      const ids = input.catalogs[harness.id] ?? [];
      for (const id of ids) {
        if (id.includes(":batch") || isSpecializedModel(id)) continue;

        // 1. Модальности: текстовая модель не годится для задачи с картинкой.
        if (modalities.length > 0 && prefs.modalitiesOf) {
          const mods = prefs.modalitiesOf(id);
          if (mods !== null && !modalities.every((m) => mods.includes(m))) {
            dropped.modality += 1;
            continue;
          }
        }

        const tier = resolveTier(id, boundaries).tier;
        const allowed = allowedFor(tier);
        if (allowed && !allowed.has(id)) {
          dropped.shortlist += 1;
          continue;
        }

        const candidate = scoreModel(harness, id, quotas, tier);
        // 2. Вендоры, у которых нет лимита или мёртвые креды, выбывают целиком.
        if (blocked.has(candidate.vendor)) {
          dropped.deadVendor += 1;
          continue;
        }
        if (candidate.quotaPercent !== null && candidate.quotaPercent >= 100) {
          dropped.deadVendor += 1;
          if (tier === wantedTier) exhausted = true;
          continue;
        }

        picks.push({
          harness,
          candidate: allowed ? { ...candidate, viaShortlist: true } : candidate,
          tier,
          distance: Math.abs(tierRank(tier) - wantedRank),
        });
      }
    }

    if (picks.length === 0) return { pick: null, dropped, exhausted };

    // 3. Сортировка одним числом: цена источника плюс штраф за отход от тира.
    const cost = (p: Pick): number =>
      FUNDING_COST[p.candidate.funding] + p.distance * TIER_DISTANCE_COST;
    picks.sort((a, b) => {
      const byCost = cost(a) - cost(b);
      if (byCost !== 0) return byCost;
      const byQuality = qualityScore(b.candidate.id) - qualityScore(a.candidate.id);
      if (byQuality !== 0) return byQuality;
      const byScore = b.candidate.score - a.candidate.score;
      if (byScore !== 0) return byScore;
      return a.harness.tieBreak - b.harness.tieBreak;
    });

    return { pick: picks[0]!, dropped, exhausted };
  };

  /**
   * Требования ослабляются по одному, а не отклоняются целиком: классификатор
   * легко просит невозможное («скриншот» тянул computerUse, картинка — vision,
   * и ни один харнес не умеет и то и другое).
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

  let usedLevel = levels[0]!;
  let result = scan(cls.requires);
  if (!result.pick) {
    for (const level of levels.slice(1)) {
      const retry = scan(level.requires);
      if (retry.pick) {
        result = retry;
        usedLevel = level;
        reasons.push(`Требования ослаблены (${level.label}): харнеса, умеющего всё сразу, нет`);
        break;
      }
    }
  }

  if (!result.pick) {
    // Последний рубеж: не подошло ничего. Работать всё равно надо.
    const fallback: Pick[] = [];
    for (const harness of pool) {
      for (const id of input.catalogs[harness.id] ?? []) {
        if (id.includes(":batch") || isSpecializedModel(id)) continue;
        const tier = resolveTier(id, boundaries).tier;
        const candidate = scoreModel(harness, id, quotas, tier);
        if (blocked.has(candidate.vendor)) continue;
        if (candidate.quotaPercent !== null && candidate.quotaPercent >= 100) continue;
        fallback.push({ harness, candidate, tier, distance: Math.abs(tierRank(tier) - wantedRank) });
      }
    }
    fallback.sort((a, b) => b.candidate.score - a.candidate.score);
    if (fallback.length === 0) {
      throw new Error("Ни один харнес не доступен: проверьте настройки плагина model-router");
    }
    result = {
      pick: fallback[0]!,
      dropped: result.dropped,
      exhausted: result.exhausted,
    };
    reasons.push("Ни один харнес не выполняет требования задачи — взят лучший доступный вариант");
  }

  const { harness, candidate, tier, distance } = result.pick!;
  reasons.push(
    `Возможности: ${
      usedLevel.requires.length ? usedLevel.requires.join(", ") : "базовые (BB-инструменты)"
    }`,
  );
  reasons.push(
    `Тир: ${tier}${distance === 0 ? "" : ` (запрошен ${wantedTier}, взят ${tier}: подписки ближе не осталось)`} — ${
      cls.reasons.find((r) => r.tier)?.note ?? "—"
    }`,
  );
  if (modalities.length) {
    reasons.push(
      `Требуются модальности: ${modalities.join(", ")}${
        candidate.modalitiesUnconfirmed
          ? " (подтвердить не удалось — выбран из тех, у кого модальности неизвестны)"
          : ""
      }`,
    );
  }
  reasons.push(
    `Платит: ${candidate.vendor} (${candidate.funding})${
      candidate.funding === "credits" ? " — подписок с лимитом не осталось, это кредиты" : ""
    }`,
  );
  if (result.exhausted && candidate.funding !== "subscription") {
    reasons.push("В запрошенном тире подписки исчерпаны");
  }
  reasons.push(
    candidate.viaShortlist
      ? "Модель взята из короткого списка рабочих лошадок"
      : "Короткий список не дал кандидата — выбор по всему каталогу",
  );
  reasons.push(`Харнес: ${harness.id} — умеет всё требуемое, версия ${harness.version}`);

  const alternatives = (input.catalogs[harness.id] ?? [])
    .filter((id) => resolveTier(id, boundaries).tier === tier && id !== candidate.id)
    .filter((id) => !isSpecializedModel(id) && !id.includes(":batch"))
    .map((id) => ({ id, s: qualityScore(id) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((x) => x.id);

  return {
    task: input.task.text,
    requires: usedLevel.requires,
    tier,
    tierDowngradedFrom: distance === 0 ? null : wantedTier,
    harnessId: harness.id,
    modelId: candidate.id,
    funding: candidate.funding,
    billingVendor: candidate.vendor,
    harnessCandidates: pool.map((h) => ({
      id: h.id,
      ok: h.id === harness.id,
      missingCapabilities: missing(h, usedLevel.requires),
      best: h.id === harness.id ? candidate : undefined,
      score: h.id === harness.id ? candidate.score : -1,
      why: h.id === harness.id ? "выбран" : "не выбран",
    })),
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
