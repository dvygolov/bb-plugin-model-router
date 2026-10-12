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
import { DEFAULT_FRONTIER_FLOOR, type Tier } from "./src/core/tiers";

const PROVIDER_ID = "router";

const TIERS: Tier[] = ["low", "middle", "subFrontier", "frontier"];

/** Picker rows shown by the router provider. Ids are labels, never agent model ids. */
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
  zai: { percent: 16, window: "monthly" },
  "opencode-go": { percent: 100, window: "monthly", note: "исчерпано" },
  openrouter: { percent: 60, window: "credits" },
};

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
  dryRun: boolean;
  blockedVendors: string[];
  announce: "off" | "first" | "always";
  judgeEnabled: boolean;
  judgeBaseUrl: string;
  judgeApiKey: string;
  judgeModel: string;
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

  let effective: EffectiveSettings = {
    harnesses: DEFAULT_HARNESSES,
    launchSpecs: DEFAULT_LAUNCH_SPECS,
    quotas: DEFAULT_QUOTAS,
    frontierFloor: DEFAULT_FRONTIER_FLOOR,
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
      dryRun: raw.dryRun === true,
      blockedVendors: parseJson(raw.blockedVendors as string, ["openai-codex"]),
      announce: raw.announce === "off" ? "off" : raw.announce === "always" ? "always" : "first",
      judgeEnabled: raw.judgeEnabled !== false,
      judgeBaseUrl: (raw.judgeBaseUrl as string) || "https://api.z.ai/api/paas/v4",
      judgeModel: (raw.judgeModel as string) || "glm-5.3-flash",
      judgeApiKey: (raw.judgeApiKey as string) ?? "",
    };
  };

  void readSettings();
  settings.onChange(() => void readSettings());

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

  async function resolveTask(text: string, inRepo = false): Promise<{ decision: Decision; judged: boolean }> {
    const cls = classify({ text, inRepo });
    const askJudge = judge();
    if (cls.confidence === "low" && askJudge) {
      const verdict = await askJudge(text);
      if (verdict) {
        const decision = decide({
          task: { text, inRepo },
          catalogs: CATALOGS,
          quotas: effective.quotas,
          prefs: {
            allowedHarnesses: effective.harnesses,
            blockedVendors: effective.blockedVendors,
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
        quotas: effective.quotas,
        prefs: { allowedHarnesses: effective.harnesses, blockedVendors: effective.blockedVendors },
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
      const forcedTier = MODEL_TO_TIER[context.model];
      const cached = decisions.get(context.threadId);

      let decision = cached;
      if (!decision || (forcedTier && decision.tier !== forcedTier)) {
        decision = decide({
          task: { text: "" },
          catalogs: CATALOGS,
          quotas: effective.quotas,
          prefs: {
            allowedHarnesses: effective.harnesses,
            blockedVendors: effective.blockedVendors,
            ...(forcedTier ? { forceTier: forcedTier } : {}),
          },
        });
      }

      const launchSpec =
        effective.launchSpecs[decision.harnessId] ?? DEFAULT_LAUNCH_SPECS[decision.harnessId];
      if (!launchSpec) return {};

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
        routerModel: decision.modelId,
        routerHeader: `🧭 Router → ${decision.harnessId} · ${decision.modelId} (${decision.tier}, ${decision.billingVendor})`,
        routerAnnounce: effective.announce,
        routerHarness: decision.harnessId,
        routerTier: decision.tier,
        routerDryRun: effective.dryRun,
      };
    },
  });

  bb.events.on("message.queued", async ({ entry }) => {
    const threadId = (entry as { threadId?: string }).threadId;
    if (!threadId) return;
    const text = messageText((entry as { content?: unknown }).content);
    if (!text) return;
    try {
      const { decision } = await resolveTask(text);
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
  const CREDENTIAL_ERROR =
    /(not connected|no api key|api key or login|token refresh failed|unauthorized|invalid api key|authentication|истек|протух)/i;

  bb.events.on("turn.failed", async (event) => {
    const threadId = (event as { threadId?: string }).threadId;
    if (!threadId) return;
    const decision = decisions.get(threadId);
    if (!decision) return;
    const errorInfo = (event as { errorInfo?: unknown }).errorInfo;
    const text = errorInfo ? JSON.stringify(errorInfo) : "";
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
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      switch (command) {
        case "explain": {
          const text = rest.join(" ").trim();
          if (!text) return { exitCode: 2, stderr: 'Использование: bb route explain "<задача>"' };
          const { decision, judged } = await resolveTask(text);
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
        case "blocked": {
          const list = effective.blockedVendors.length ? effective.blockedVendors.join(", ") : "нет";
          return { exitCode: 0, stdout: `Заблокированные вендоры: ${list}\nСнять: bb plugin config model-router set blockedVendors "[]"\n` };
        }
        case "quota": {
          const lines = Object.entries(effective.quotas).map(
            ([vendor, q]) => `${vendor.padEnd(24)} ${String(q.percent).padStart(3)}%  ${q.window ?? ""} ${
              q.percent >= 100 ? "SKIP" : ""
            } ${q.note ?? ""}`,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
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
