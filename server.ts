// bb-plugin-model-router — server entry.
//
// Registers the `router` provider: a picker entry that decides, once per thread,
// which harness to run and which model to run on it. The decision is made when
// the thread's first message is queued (off the hot path), cached by threadId,
// and handed to the provider bridge per command as providerOptions.
//
// The bridge (host.ts) puts the resolved model id back into the command before
// the generic ACP bridge launches the agent, because the picker shows tiers, not
// agent model ids.

import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import catalogsJson from "./src/core/catalogs.json";
import { HARNESSES } from "./src/core/capabilities";
import { classify } from "./src/core/classify";
import { decide, summarize, type Decision, type QuotaState } from "./src/core/decide";
import { makeHttpJudge, type JudgeFn } from "./src/core/judge";
import shortlistJson from "./src/core/shortlist.json";
import {
  allEntries,
  applyTierOverrides,
  describe as describeModel,
  generatedAt,
  idsForCanonical,
  modalitiesForId,
  shortlistIds,
} from "./src/core/registry";
import { DEFAULT_FRONTIER_FLOOR, type Tier } from "./src/core/tiers";

const PROVIDER_ID = "router";

const TIER_ROWS: { id: string; displayName: string; description: string }[] = [
  { id: "auto", displayName: "Auto — решить по задаче", description: "Роутер сам определит тир по тексту задачи" },
  { id: "frontier", displayName: "Frontier — текущие флагманы", description: "Только свежие флагманы OpenAI, Anthropic, Gemini, Grok" },
  { id: "sub-frontier", displayName: "Sub-Frontier — Kimi / DeepSeek / GLM", description: "Сильные китайские флагманы, обычно по подписке" },
  { id: "middle", displayName: "Middle — рабочие лошадки", description: "Механические правки, дешёвые рабочие модели" },
  { id: "low", displayName: "Low — дешёвые и бесплатные", description: "Одноразовые задачи, бесплатные модели" },
];

const REASONING_EFFORTS = [{ reasoningEffort: "medium" as const, description: "Medium" }];

const TIER_MODELS = TIER_ROWS.map((row, index) => ({
  id: row.id,
  displayName: row.displayName,
  description: row.description,
  model: row.id,
  isDefault: index === 0,
  defaultReasoningEffort: "medium" as const,
  supportedReasoningEfforts: REASONING_EFFORTS,
}));

const MODEL_TO_TIER: Record<string, Tier | undefined> = {
  auto: undefined,
  frontier: "frontier",
  "sub-frontier": "subFrontier",
  middle: "middle",
  low: "low",
};

/** Verified ACP launch commands: `opencode acp`, `omp acp`, `hermes acp`. */
const DEFAULT_LAUNCH_SPECS: Record<string, { displayName: string; command: string; args: string[]; env: Record<string, string> }> = {
  "acp-opencode": { displayName: "opencode", command: "opencode", args: ["acp"], env: {} },
  "acp-omp": { displayName: "omp", command: "omp", args: ["acp"], env: {} },
  "acp-hermes-agent": { displayName: "Hermes", command: "hermes", args: ["acp"], env: {} },
};

/** Nothing here is guessed: these are the three harnesses that speak ACP. */
const DEFAULT_HARNESSES = ["acp-omp", "acp-hermes-agent", "acp-opencode"];

/** Живые квоты на момент сборки; обновляются командой `bb route quota`. */
const DEFAULT_QUOTAS: Record<string, QuotaState> = {
  kimi: { percent: 20, window: "weekly" },
  "kimi-coding": { percent: 20, window: "weekly" },
  "kimi-code": { percent: 20, window: "weekly" },
  "kimi-for-coding-oauth": { percent: 20, window: "weekly" },
  "kimi-oauth": { percent: 20, window: "weekly", note: "та же подписка Kimi (hermes)" },
  zai: { percent: 16, window: "monthly" },
  "opencode-go": { percent: 100, window: "monthly", note: "исчерпано" },
  openrouter: { percent: 60, window: "credits" },
};

/** Списки тиров по умолчанию — прямо из реестра, чтобы настройка их только правила. */
const REGISTRY_ENTRIES = allEntries();
const DEFAULT_FRONTIER_MODELS = REGISTRY_ENTRIES.filter((e) => e.tier === "frontier").map((e) => e.canonical);
const DEFAULT_SUB_FRONTIER_MODELS = REGISTRY_ENTRIES.filter((e) => e.tier === "subFrontier").map(
  (e) => e.canonical,
);

/** Короткий список «рабочих лошадок»: тир → канонические модели, порядок = приоритет. */
const SHORTLIST = shortlistJson as unknown as {
  generatedAt: string;
  tiers: Record<string, { model: string; purpose: string; harnesses: string[]; ids: string[] }[]>;
};
const DEFAULT_SHORTLIST: Record<string, string[]> = Object.fromEntries(
  Object.entries(SHORTLIST.tiers).map(([tier, entries]) => [tier, entries.map((e) => e.model)]),
);

/**
 * id модели → харнес, который её запускает. Нужно, чтобы понять ручное прижатие:
 * в пикере рядом с моделью показан харнес, и выбор такой строки означает «взять
 * именно эту пару».
 */
const HARNESS_OF_ID = new Map<string, string>();
{
  const labelToProvider: Record<string, string> = {
    omp: "acp-omp",
    hermes: "acp-hermes-agent",
    opencode: "acp-opencode",
  };
  for (const entries of Object.values(SHORTLIST.tiers)) {
    for (const entry of entries) {
      for (const [label, ids] of Object.entries(entry.idsByHarness ?? {})) {
        const provider = labelToProvider[label];
        if (!provider) continue;
        for (const id of ids) if (!HARNESS_OF_ID.has(id)) HARNESS_OF_ID.set(id, provider);
      }
    }
  }
}

const TIERS: Tier[] = ["low", "middle", "subFrontier", "frontier"];

/** Picker rows shown by the router provider. Ids are labels, never agent model ids. */

const CATALOGS: Record<string, string[]> = {};
for (const [provider, models] of Object.entries(
  (catalogsJson as { providers: Record<string, { id: string }[]> }).providers,
)) {
  CATALOGS[provider] = models.map((m) => m.id).filter(Boolean);
}

interface EffectiveSettings {
  harnesses: string[];
  launchSpecs: typeof DEFAULT_LAUNCH_SPECS;
  quotas: Record<string, QuotaState>;
  frontierFloor: Record<string, number>;
  frontierModels: string[];
  subFrontierModels: string[];
  /** тир → конкретные id моделей из короткого списка */
  shortlistByTier: Record<string, string[]>;
  dryRun: boolean;
  blockedVendors: string[];
  announce: "off" | "first" | "always";
  judgeEnabled: boolean;
  judgeBaseUrl: string;
  judgeApiKey: string;
  judgeModel: string;
}

/** Вендор id: двоеточие считается разделителем, только если оно раньше слэша. */
function vendorHead(id: string): string {
  const colon = id.indexOf(":");
  const slash = id.indexOf("/");
  return colon !== -1 && (slash === -1 || colon < slash) ? id.slice(0, colon) : id.split("/")[0] ?? "";
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Что за вложения пришли с сообщением: "image", "audio", "video".
 * Блоки вложения различаются по типу, а не по расширению.
 */
export function messageModalities(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const found = new Set<string>();
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    const type = typeof b["type"] === "string" ? (b["type"] as string).toLowerCase() : "";
    const mime = typeof b["mimeType"] === "string" ? (b["mimeType"] as string).toLowerCase() : "";
    if (type.includes("image") || mime.startsWith("image/")) found.add("image");
    else if (type.includes("audio") || mime.startsWith("audio/")) found.add("audio");
    else if (type.includes("video") || mime.startsWith("video/")) found.add("video");
  }
  return [...found];
}

/** Text of a queued message, flattened from its blocks. */
export function messageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as Record<string, unknown>;
      return typeof b["text"] === "string" ? b["text"] : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    harnesses: {
      type: "string",
      label: "Допустимые харнесы (JSON, только ACP)",
      experimental_multiline: true,
      default: JSON.stringify(DEFAULT_HARNESSES),
    },
    launchSpecs: {
      type: "string",
      label: "Команды запуска ACP-агентов (JSON)",
      experimental_multiline: true,
      default: JSON.stringify(DEFAULT_LAUNCH_SPECS, null, 2),
    },
    quotas: {
      type: "string",
      label: "Квоты вендоров в процентах (JSON)",
      experimental_multiline: true,
      default: JSON.stringify(DEFAULT_QUOTAS, null, 2),
    },
    shortlist: {
      type: "string",
      label: "Короткий список рабочих лошадок: тир → канонические модели (JSON)",
      experimental_multiline: true,
      default: JSON.stringify(DEFAULT_SHORTLIST, null, 2),
    },
    frontierModels: {
      type: "string",
      label: "Frontier — канонические модели (JSON). Заменяет правило по семействам",
      experimental_multiline: true,
      default: JSON.stringify(DEFAULT_FRONTIER_MODELS, null, 2),
    },
    subFrontierModels: {
      type: "string",
      label: "Sub-Frontier — канонические модели (JSON)",
      experimental_multiline: true,
      default: JSON.stringify(DEFAULT_SUB_FRONTIER_MODELS, null, 2),
    },
    frontierFloor: {
      type: "string",
      label: "Порог версии для Frontier-семейств (JSON)",
      experimental_multiline: true,
      default: JSON.stringify(DEFAULT_FRONTIER_FLOOR, null, 2),
    },
    dryRun: { type: "boolean", label: "Только показывать решение, не запускать", default: false },
    blockedVendors: {
      type: "string",
      label: "Вендоры с мёртвыми кредами (JSON). Сейчас у hermes протух OAuth ChatGPT — уберите openai-codex после повторного входа",
      experimental_multiline: true,
      default: JSON.stringify(["openai-codex"]),
    },
    announce: {
      type: "select",
      label: "Объявлять выбор в чате",
      options: ["off", "first", "always"],
      default: "first",
    },
    judgeEnabled: { type: "boolean", label: "Звать дешёвого судью при низкой уверенности", default: true },
    judgeBaseUrl: { type: "string", label: "Судья: base URL", default: "https://api.z.ai/api/paas/v4" },
    judgeModel: { type: "string", label: "Судья: модель", default: "glm-5.3-flash" },
    judgeApiKey: { type: "string", label: "Судья: API-ключ", secret: true },
  });

  /**
   * Живые квоты из BB (`system.usageLimits`) — те же данные, что показывает
   * `bb extra-usage`. Перекрывают статичные настройки: у Z.ai лимит пятичасовой,
   * и статичный «месяц 16%» не замечал, что он выбран.
   */
  let liveQuotas: Record<string, QuotaState> = {};
  let liveQuotasAt = 0;
  let liveQuotasError = "";
  let liveQuotasDebug = "";

  /** "host_v9hnxzge4c:zai" / "Zai" / "openrouter" → наш ключ вендора. */
  function vendorFromProviderId(rawId: string): string | null {
    const tail = rawId.toLowerCase().split(/[:/]/).filter(Boolean).pop() ?? "";
    if (!tail) return null;
    return PROVIDER_ALIASES[tail] ?? (/(zai|kimi|openrouter|opencode)/.test(tail) ? tail.replace(/\s+/g, "-") : null);
  }

  const PROVIDER_ALIASES: Record<string, string> = {
    zai: "zai",
    "z.ai": "zai",
    kimi: "kimi",
    "kimi for coding": "kimi",
    openrouter: "openrouter",
    opencode: "opencode-go",
    "opencode go": "opencode-go",
    opencodego: "opencode-go",
  };

  const worstWindow = (windows: Record<string, unknown>[]): QuotaState | null => {
    let worst: QuotaState | null = null;
    for (const w of windows) {
      const percent = typeof w["usedPercent"] === "number" ? (w["usedPercent"] as number) : 0;
      if (!worst || percent > worst.percent) {
        worst = {
          percent,
          window: (w["label"] as string) ?? (w["kind"] as string) ?? undefined,
          resetsAt: (w["resetsAt"] as string) ?? undefined,
          note: "живые данные BB",
        };
      }
    }
    return worst;
  };

  /**
   * Z.ai, Kimi и OpenRouter BB сам не опрашивает — это умеет плагин extra-usage.
   * Читаем его через межплагинный RPC: у Z.ai пятичасовое окно, и без этих данных
   * роутер выбирал уже исчерпанную подписку.
   */
  async function refreshFromExtraUsage(): Promise<Record<string, QuotaState>> {
    const out: Record<string, QuotaState> = {};
    const callRpc = (
      bb as unknown as {
        sdk: { plugins: { callRpc: (args: Record<string, unknown>) => Promise<unknown> } };
      }
    ).sdk.plugins.callRpc.bind(
      (bb as unknown as { sdk: { plugins: unknown } }).sdk.plugins,
    );
    const list = (await callRpc({
      pluginId: "extra-usage",
      method: "provider-usage.v1.listResources",
      input: {},
      outputSchema: z.unknown(),
    })) as { resources?: Record<string, unknown>[] } | null;

    for (const resource of list?.resources ?? []) {
      const id = typeof resource["id"] === "string" ? (resource["id"] as string) : null;
      if (!id) continue;
      const vendor = vendorFromProviderId(
        String(resource["label"] ?? resource["providerId"] ?? id),
      );
      if (!vendor) continue;
      let observation: Record<string, unknown> | null = null;
      try {
        observation = (await callRpc({
          pluginId: "extra-usage",
          method: "provider-usage.v1.getResource",
          input: { resourceId: id, refresh: false },
          outputSchema: z.unknown(),
        })) as Record<string, unknown> | null;
      } catch {
        continue; // один ресурс не прочитался — остальные важнее
      }
      const usage =
        ((observation?.["usage"] ?? (observation?.["observation"] as Record<string, unknown>)?.["usage"]) ??
          {}) as Record<string, unknown>;
      if (usage["status"] !== "ok") continue;
      const worst = worstWindow((usage["windows"] ?? []) as Record<string, unknown>[]);
      if (worst) out[vendor] = { ...worst, note: "живые данные extra-usage" };
    }
    return out;
  }

  async function refreshLiveQuotas(): Promise<void> {
    try {
      // Ответ — запись «id провайдера → состояние», окна лежат прямо в ней.
      const result = (await bb.sdk.system.usageLimits()) as Record<string, unknown> | null;
      const next: Record<string, QuotaState> = {};
      const seen: string[] = [];
      for (const [rawId, rawValue] of Object.entries(result ?? {})) {
        const value = (rawValue ?? {}) as Record<string, unknown>;
        seen.push(`${rawId}:${String(value["status"])}`);
        if (value["status"] !== "ok") continue;
        const vendor = vendorFromProviderId(rawId);
        if (!vendor) continue;
        const windows = (value["windows"] ?? []) as Record<string, unknown>[];
        // Берём самое исчерпанное окно: упёрлось любое — вендор недоступен.
        let worst: QuotaState | null = null;
        for (const w of windows) {
          const percent = typeof w["usedPercent"] === "number" ? (w["usedPercent"] as number) : 0;
          if (!worst || percent > worst.percent) {
            worst = {
              percent,
              window: (w["label"] as string) ?? undefined,
              resetsAt: (w["resetsAt"] as string) ?? undefined,
              note: "живые данные BB",
            };
          }
        }
        if (worst) next[vendor] = worst;
      }
      // Плюс то, что BB сам не опрашивает: Z.ai, Kimi, OpenRouter.
      let extra: Record<string, QuotaState> = {};
      try {
        extra = await refreshFromExtraUsage();
      } catch (error) {
        liveQuotasError = `extra-usage: ${String(error).slice(0, 200)}`;
      }
      const merged = { ...next, ...extra };
      liveQuotasDebug =
        `BB: ${seen.join(", ") || "—"}; extra-usage: ${Object.keys(extra).join(", ") || "—"}`.slice(0, 400);
      if (Object.keys(merged).length > 0) {
        liveQuotas = merged;
        liveQuotasAt = Date.now();
      }
    } catch (error) {
      liveQuotasError = String(error).slice(0, 400);
    }
  }

  /** Статичные настройки + живые данные (живые важнее). */
  const quotasNow = (): Record<string, QuotaState> => ({ ...effective.quotas, ...liveQuotas });

  let effective: EffectiveSettings = {
    harnesses: DEFAULT_HARNESSES,
    launchSpecs: DEFAULT_LAUNCH_SPECS,
    quotas: DEFAULT_QUOTAS,
    frontierFloor: DEFAULT_FRONTIER_FLOOR,
    frontierModels: DEFAULT_FRONTIER_MODELS,
    subFrontierModels: DEFAULT_SUB_FRONTIER_MODELS,
    shortlistByTier: {},
    dryRun: false,
    blockedVendors: ["openai-codex"],
    announce: "first",
    judgeEnabled: true,
    judgeBaseUrl: "https://api.z.ai/api/paas/v4",
    judgeModel: "glm-5.3-flash",
    judgeApiKey: "",
  };

  const readSettings = async () => {
    const raw = await settings.get();
    effective = {
      harnesses: parseJson(raw.harnesses as string, DEFAULT_HARNESSES).filter((id) =>
        DEFAULT_HARNESSES.includes(id),
      ),
      launchSpecs: parseJson(raw.launchSpecs as string, DEFAULT_LAUNCH_SPECS),
      quotas: parseJson(raw.quotas as string, DEFAULT_QUOTAS),
      frontierFloor: parseJson(raw.frontierFloor as string, DEFAULT_FRONTIER_FLOOR),
      frontierModels: parseJson(raw.frontierModels as string, DEFAULT_FRONTIER_MODELS),
      subFrontierModels: parseJson(raw.subFrontierModels as string, DEFAULT_SUB_FRONTIER_MODELS),
      shortlistByTier: Object.fromEntries(
        Object.entries(parseJson(raw.shortlist as string, DEFAULT_SHORTLIST)).map(([tier, names]) => [
          tier,
          shortlistIds(names),
        ]),
      ),
      dryRun: raw.dryRun === true,
      blockedVendors: parseJson(raw.blockedVendors as string, ["openai-codex"]),
      announce: raw.announce === "off" ? "off" : raw.announce === "always" ? "always" : "first",
      judgeEnabled: raw.judgeEnabled !== false,
      judgeBaseUrl: (raw.judgeBaseUrl as string) || "https://api.z.ai/api/paas/v4",
      judgeModel: (raw.judgeModel as string) || "glm-5.3-flash",
      judgeApiKey: (raw.judgeApiKey as string) ?? "",
    };
    applyTierOverrides(effective.frontierModels, effective.subFrontierModels);
  };

  void readSettings();
  settings.onChange(() => void readSettings());
  void refreshLiveQuotas();
  // Раз в минуту: пятичасовые окна меняются быстро, а решение принимается на
  // пути отправки — читать их там нельзя.
  const quotaTimer = setInterval(() => void refreshLiveQuotas(), 60_000);
  quotaTimer.unref?.();

  const judge = (): JudgeFn | null =>
    effective.judgeEnabled && effective.judgeApiKey
      ? makeHttpJudge({
          baseUrl: effective.judgeBaseUrl,
          apiKey: effective.judgeApiKey,
          model: effective.judgeModel,
        })
      : null;

  /** threadId → decision. Written when a message is queued, read on the hot path. */
  const decisions = new Map<string, Decision>();

  /** threadId → какую модель уже выставили в UI, чтобы не писать в базу каждый ход. */
  const pinApplied = new Map<string, string>();
  let logPinFailure = true;

  async function resolveTask(
    text: string,
    inRepo = false,
    modalities: string[] = [],
  ): Promise<{ decision: Decision; judged: boolean }> {
    // Квоты перечитываем перед решением, а не только по таймеру: пятичасовое
    // окно меняется быстро, а на старте плагина SDK ещё не привязан и первый
    // опрос не проходит.
    if (Date.now() - liveQuotasAt > 30_000) await refreshLiveQuotas();

    const cls = classify({ text, inRepo, images: modalities.includes("image") ? 1 : 0 });
    const askJudge = judge();
    if (cls.confidence === "low" && askJudge) {
      const verdict = await askJudge(text);
      if (verdict) {
        const decision = decide({
          task: { text, inRepo },
          catalogs: CATALOGS,
          quotas: quotasNow(),
          prefs: {
            allowedHarnesses: effective.harnesses,
            blockedVendors: effective.blockedVendors,
            shortlist: effective.shortlistByTier,
            requiredModalities: modalities,
            modalitiesOf: modalitiesForId,
            forceTier: verdict.tier,
            extraCapabilities: verdict.capabilities,
          },
        });
        decision.reasons.unshift(`Судья (${effective.judgeModel}): ${verdict.note || "—"}`);
        return { decision, judged: true };
      }
    }
    return {
      decision: decide({
        task: { text, inRepo },
        catalogs: CATALOGS,
        quotas: quotasNow(),
        prefs: {
          allowedHarnesses: effective.harnesses,
          blockedVendors: effective.blockedVendors,
          shortlist: effective.shortlistByTier,
          requiredModalities: modalities,
          modalitiesOf: modalitiesForId,
        },
      }),
      judged: false,
    };
  }

  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "Router (auto)",
    icon: "Route",
    strings: {
      signInHint: "Роутер запускает ACP-агентов: opencode, omp, hermes.",
      expiredHint: "Роутер не смог запустить ACP-агента. Проверьте `bb route doctor`.",
      installUrl: "https://github.com/dvygolov/bb-plugin-model-router",
      brandPrefix: "Router ",
    },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["medium"],
    },
    reasoningLevels: [{ id: "medium", label: "Medium" }],
    composerActions: [],
    models: { fallback: TIER_MODELS, scope: "host" },
    env: {
      passthrough: [
        "PATH",
        "HOME",
        "OPENROUTER_API_KEY",
        "ZAI_API_KEY",
        "GLM_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GROQ_API_KEY",
        "OPENCODE_GO_API_KEY",
      ],
    },
    deriveProviderOptions(context) {
      // Hot path: synchronous, no I/O. Everything heavy happened at queue time.
      const pinnedHarness = HARNESS_OF_ID.get(context.model);
      const pinned = pinnedHarness ? { harnessId: pinnedHarness, modelId: context.model } : null;
      const forcedTier = MODEL_TO_TIER[context.model];
      const cached = decisions.get(context.threadId);

      let decision: Decision;
      if (pinned) {
        // Ручное прижатие: пользователь сам выбрал пару «харнес · модель».
        decision = decide({
          task: { text: "" },
          catalogs: CATALOGS,
          quotas: quotasNow(),
          prefs: {
            allowedHarnesses: [pinned.harnessId],
            blockedVendors: effective.blockedVendors,
            ...(cached ? { forceTier: cached.tier } : {}),
          },
        });
        decision = { ...decision, harnessId: pinned.harnessId, modelId: pinned.modelId };
      } else if (cached && (!forcedTier || cached.tier === forcedTier)) {
        decision = cached;
      } else {
        decision = decide({
          task: { text: "" },
          catalogs: CATALOGS,
          quotas: quotasNow(),
          prefs: {
            allowedHarnesses: effective.harnesses,
            blockedVendors: effective.blockedVendors,
            shortlist: effective.shortlistByTier,
            ...(forcedTier ? { forceTier: forcedTier } : {}),
          },
        });
      }

      const launchSpec =
        effective.launchSpecs[decision.harnessId] ?? DEFAULT_LAUNCH_SPECS[decision.harnessId];
      if (!launchSpec) return {};

      const rowId = decision.modelId;
      // Показываем выбор в интерфейсе: BB рисует в пикере модели то, что записано
      // у треда. Провайдер остаётся «Router (auto)» — BB не даёт его менять у
      // живого треда, — а вот поле модели становится «харнес · модель».
      if (context.model !== rowId && pinApplied.get(context.threadId) !== rowId) {
        pinApplied.set(context.threadId, rowId);
        void bb.sdk.threads
          .update({ threadId: context.threadId, model: rowId })
          .catch((error: unknown) => {
            pinApplied.delete(context.threadId);
            if (logPinFailure) {
              logPinFailure = false;
              console.warn(`model-router: не удалось показать выбор в UI: ${String(error)}`);
            }
          });
      }

      void bb.sdk.threads
        .updatePluginMetadata({
          threadId: context.threadId,
          pluginId: bb.pluginId,
          set: {
            harness: decision.harnessId,
            model: decision.modelId,
            tier: decision.tier,
            billing: `${decision.billingVendor}:${decision.funding}`,
            reason: summarize(decision).slice(0, 2000),
          },
        })
        .catch(() => undefined);

      return {
        acpLaunchSpec: launchSpec,
        acpDialect: "generic",
        routerModels: JSON.stringify(TIER_MODELS),
        routerModel: decision.modelId,
        routerHeader: `🧭 Router → ${decision.harnessId} · ${decision.modelId} (${decision.tier}, ${decision.billingVendor})`,
        routerAnnounce: effective.announce,
        routerHarness: decision.harnessId,
        routerTier: decision.tier,
        routerDryRun: effective.dryRun,
      };
    },
  });

  /**
   * Вложения приходят не в очередь сообщения, а в input хода — поэтому о
   * картинке узнаём здесь. Хук выполняется до того, как провайдер запущен, так
   * что решение отсюда успевает попасть в deriveProviderOptions.
   */
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    try {
      const modalities = messageModalities(ctx.input.blocks);
      if (modalities.length > 0) {
        const { decision } = await resolveTask(ctx.input.text ?? "", false, modalities);
        decisions.set(ctx.thread.id, decision);
      }
    } catch {
      // Политика не имеет права ломать отправку сообщения.
    }
    return { action: "proceed" };
  });

  bb.events.on("message.queued", async ({ entry }) => {
    const threadId = (entry as { threadId?: string }).threadId;
    if (!threadId) return;
    const content = (entry as { content?: unknown }).content;
    const text = messageText(content);
    const modalities = messageModalities(content);
    if (!text && modalities.length === 0) return;
    try {
      const { decision } = await resolveTask(text, false, modalities);
      decisions.set(threadId, decision);
    } catch {
      // Роутер не имеет права ломать отправку сообщения.
    }
  });

  /**
   * Самовосстановление: если ход упал на неработающих кредах вендора, помечаем
   * вендора мёртвым и сбрасываем решение, чтобы следующий ход ушёл другим путём.
   * Без этого тред остаётся прикованным к тому, что не работает.
   */
  const LIMIT_ERROR = /(rate.?limit|usage limit|quota|429|too many requests|лимит)/i;

  const CREDENTIAL_ERROR =
    /(not connected|no api key|api key or login|token refresh failed|unauthorized|invalid api key|authentication|истек|протух)/i;

  bb.events.on("turn.failed", async (event) => {
    const threadId = (event as { threadId?: string }).threadId;
    if (!threadId) return;
    const decision = decisions.get(threadId);
    if (!decision) return;
    const errorInfo = (event as { errorInfo?: unknown }).errorInfo;
    const text = errorInfo ? JSON.stringify(errorInfo) : "";

    // Лимит по факту: данные BB могли не успеть обновиться, а провайдер уже
    // сказал «хватит» и назвал время сброса. Верим провайдеру.
    if (LIMIT_ERROR.test(text)) {
      const rateLimits = (event as { rateLimits?: { windows?: { resetsAtMs?: number | null }[] } })
        .rateLimits;
      const resetsAtMs = rateLimits?.windows?.find((w) => typeof w.resetsAtMs === "number")?.resetsAtMs;
      liveQuotas = {
        ...liveQuotas,
        [decision.billingVendor]: {
          percent: 100,
          window: "до сброса",
          resetsAt: resetsAtMs ? new Date(resetsAtMs).toISOString() : undefined,
          note: "пойман 429",
        },
      };
      decisions.delete(threadId);
      void refreshLiveQuotas();
    }

    if (!CREDENTIAL_ERROR.test(text)) return;
    if (effective.blockedVendors.includes(decision.billingVendor)) return;

    const next = [...effective.blockedVendors, decision.billingVendor];
    effective = { ...effective, blockedVendors: next };
    decisions.delete(threadId);
    try {
      await settings.experimental_set({ blockedVendors: JSON.stringify(next) });
    } catch {
      // Не смогли сохранить — в памяти всё равно уже помечено.
    }
  });

  bb.cli.register({
    name: "route",
    summary: "Роутер моделей и харнесов: решения, причины, состояние",
    commands: [
      { name: "explain", summary: "Показать решение по тексту задачи", usage: 'bb route explain "<задача>"' },
      { name: "why", summary: "Почему выбран харнес и модель в треде", usage: "bb route why [thread-id]" },
      { name: "harnesses", summary: "Реестр харнесов: возможности, кошельки, версии", usage: "bb route harnesses" },
      { name: "quota", summary: "Текущие квоты вендоров, как их видит роутер", usage: "bb route quota" },
      { name: "blocked", summary: "Вендоры с мёртвыми кредами, исключённые из выбора", usage: "bb route blocked" },
      { name: "models", summary: "Реестр моделей: тиры и имена в каждом харнесе", usage: "bb route models [модель|id]" },
      { name: "shortlist", summary: "Короткий список рабочих лошадок по тирам", usage: "bb route shortlist" },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      switch (command) {
        case "explain": {
          const wantsImage = rest.includes("--image");
          const text = rest.filter((a) => a !== "--image").join(" ").trim();
          if (!text) return { exitCode: 2, stderr: 'Использование: bb route explain [--image] "<задача>"' };
          const { decision, judged } = await resolveTask(text, false, wantsImage ? ["image"] : []);
          return { exitCode: 0, stdout: `${summarize(decision)}\n${judged ? "(через судью)" : "(по правилам)"}\n` };
        }
        case "why": {
          const threadId = rest[0] ?? ctx.threadId;
          if (!threadId) return { exitCode: 2, stderr: "Нужен thread-id или запуск внутри треда" };
          const meta = await bb.sdk.threads.getPluginMetadata({
            threadId,
            pluginId: bb.pluginId,
          });
          const data = (meta as { data?: Record<string, unknown> })?.data ?? meta;
          return { exitCode: 0, stdout: `${JSON.stringify(data, null, 2)}\n` };
        }
        case "harnesses": {
          const lines = HARNESSES.map((h) => {
            const allowed = effective.harnesses.includes(h.id) ? "✔" : "·";
            const spec = effective.launchSpecs[h.id];
            return `${allowed} ${h.id.padEnd(18)} ${h.version.padEnd(10)} ${
              spec ? `${spec.command} ${spec.args.join(" ")}` : "нет ACP-команды"
            }\n    умеет: ${h.capabilities.join(", ")}\n    платит: ${h.vendors
              .map((v) => `${v.prefix}(${v.funding})`)
              .join(", ")}`;
          });
          return { exitCode: 0, stdout: `Допустимые в роутере: ${effective.harnesses.join(", ")}\n\n${lines.join("\n")}\n` };
        }
        case "models": {
          const query = rest.join(" ").trim().toLowerCase();
          if (query) {
            const hit =
              REGISTRY_ENTRIES.find((e) => e.canonical === query) ??
              REGISTRY_ENTRIES.find((e) => e.canonical.startsWith(query)) ??
              REGISTRY_ENTRIES.find((e) =>
                Object.values(e.harnesses).some((ids) => ids.some((id) => id.toLowerCase().includes(query))),
              );
            if (!hit) return { exitCode: 1, stderr: `нет модели по запросу «${query}»` };
            return { exitCode: 0, stdout: `${describeModel(hit.canonical)}\n` };
          }
          const byTier = new Map<string, number>();
          for (const e of REGISTRY_ENTRIES) byTier.set(e.tier, (byTier.get(e.tier) ?? 0) + 1);
          const listing = REGISTRY_ENTRIES.filter((e) => e.tier === "frontier" || e.tier === "subFrontier")
            .map(
              (e) =>
                `${e.tier === "frontier" ? "F " : "SF"} ${e.canonical.padEnd(32)} ${
                  e.contextLength ? `${Math.round(e.contextLength / 1000)}k`.padEnd(6) : "—".padEnd(6)
                } ${Object.keys(e.harnesses).join(",")}`,
            );
          return {
            exitCode: 0,
            stdout: `реестр от ${generatedAt()} · ${REGISTRY_ENTRIES.length} канонических моделей · ${JSON.stringify(
              Object.fromEntries(byTier),
            )}\n\n${listing.join("\n")}\n\nПодробно: bb route models <модель|id>\n`,
          };
        }
        case "shortlist": {
          const lines: string[] = [`список от ${SHORTLIST.generatedAt}`, ""];
          for (const [tier, entries] of Object.entries(SHORTLIST.tiers)) {
            lines.push(`${tier}:`);
            for (const e of entries) {
              const ids = idsForCanonical(e.model);
              const vendors = [...new Set(ids.map(vendorHead))];
              const dead = vendors.filter((v) => effective.blockedVendors.includes(v));
              // Показываем только те вендоры, которыми реально можно платить:
              // кредиты OpenRouter не в счёт, пока есть подписка.
              const pay = vendors
                .filter((v) => v !== "openrouter")
                .map((v) => {
                  const q = effective.quotas[v];
                  return q ? `${v} ${q.percent}%` : v;
                });
              lines.push(
                `  ${e.model.padEnd(30)} ${e.purpose}${
                  (() => {
                    const mods = new Set(ids.map((id) => modalitiesForId(id)).flat().filter(Boolean) as string[]);
                    return mods.size > 0
                      ? `  [${[...mods].filter((m) => m !== "text").join("+") || "только текст"}]`
                      : "  [модальности неизвестны]";
                  })()
                }` +
                  `${dead.length ? `  ⛔ ${dead.join(", ")}` : ""}\n` +
                  `      ${e.harnesses.join(", ")} · платит: ${pay.length ? pay.join(" / ") : "OpenRouter (кредиты)"}`,
              );
            }
          }
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        case "blocked": {
          const list = effective.blockedVendors.length ? effective.blockedVendors.join(", ") : "нет";
          return { exitCode: 0, stdout: `Заблокированные вендоры: ${list}\nСнять: bb plugin config model-router set blockedVendors "[]"\n` };
        }
        case "quota": {
          await refreshLiveQuotas();
          const merged = quotasNow();
          const lines = Object.entries(merged).map(([vendor, q]) => {
            const live = liveQuotas[vendor] ? "live" : "настр.";
            const reset = q.resetsAt ? ` сброс ${q.resetsAt}` : "";
            return `${vendor.padEnd(24)} ${String(Math.round(q.percent)).padStart(3)}%  ${(q.window ?? "").padEnd(
              8,
            )} ${q.percent >= 100 ? "SKIP" : "    "} ${live}${reset ? ` ·${reset}` : ""} ${q.note ?? ""}`;
          });
          return {
            exitCode: 0,
            stdout: `данные от ${liveQuotasAt ? new Date(liveQuotasAt).toISOString() : "—"}\n${lines.join("\n")}\n${
              liveQuotasError ? `ошибка чтения: ${liveQuotasError}\n` : ""
            }${liveQuotasDebug ? `разбор: ${liveQuotasDebug}\n` : ""}`,
          };
        }
        default:
          return {
            exitCode: 2,
            stderr: [
              "bb route explain \"<задача>\"  — решение и причины",
              "bb route why [thread-id]     — что записано в журнал треда",
              "bb route harnesses           — реестр харнесов",
              "bb route quota               — квоты вендоров",
              "",
            ].join("\n"),
          };
      }
    },
  });
}

export { TIERS, PROVIDER_ID };
