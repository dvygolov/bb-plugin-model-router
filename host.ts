// bb-plugin-model-router — host entry.
//
// Ships the provider bridge for the `router` provider. The ACP bridge kit does
// the protocol work (opencode / omp / hermes all speak ACP); this wrapper adds
// two things on top of it, both driven by what server.ts publishes in
// providerOptions:
//
//   1. It rewrites the command's model. The picker shows tiers (`auto`,
//      `frontier`, …), which are not agent model ids, and the generic ACP bridge
//      has no id mapping table — so the resolved model is put back where the
//      bridge reads it from.
//   2. It posts the router's choice into the thread as its own message, right
//      after the turn opens and before the agent's first token.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import {
  createBridgeIo,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import shortlistJson from "./src/core/shortlist.json";

/** Methods whose params carry a model that must be resolved before launch. */
const MODEL_BEARING = new Set(["thread/start", "thread/resume", "thread/fork", "turn/start"]);

/**
 * Объявляем только на `turn/start`.
 *
 * На `thread/start` ход ещё не открыт: если между стартом сессии и ходом есть
 * пауза (подготовка окружения занимала 10 секунд), дельта приходит в пустоту и
 * пропадает. На `turn/start` ход открыт всегда, а агент к этому моменту ещё не
 * сгенерировал ни токена.
 */
const ANNOUNCE_ON = new Set(["turn/start"]);

/** Text stream BB renders as the agent's message; same keys the ACP bridge uses. */
const AGENT_CHANNEL = "assistant";
const DELTA_METHOD = "thread/delta";

interface CommandOptions {
  model?: unknown;
  providerOptions?: Record<string, unknown>;
}

interface Envelope {
  method?: string;
  params?: {
    threadId?: unknown;
    model?: unknown;
    providerOptions?: Record<string, unknown>;
    /** BB ставит параметры команды сюда: model, serviceTier, reasoningLevel, … */
    options?: CommandOptions;
  };
}

/** Место, куда BB кладёт модель и наши providerOptions. */
function readCommand(params: NonNullable<Envelope["params"]>): {
  options: CommandOptions;
  modelBefore: unknown;
  routerModel: unknown;
} {
  if (params.options) {
    return {
      options: params.options,
      modelBefore: params.options.model,
      routerModel: params.options.providerOptions?.["routerModel"],
    };
  }
  return {
    options: {},
    modelBefore: params.model,
    routerModel: params.providerOptions?.["routerModel"],
  };
}

/** Один бридж — один поток вывода; сообщения роутера уходят в тот же stdout. */
const io = createBridgeIo();
const announced = new Set<string>();

let logPath: string | null = null;
let seq = 0;

function log(entry: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), n: seq++, ...entry })}\n`);
  } catch {
    // Никогда не роняем бридж из-за логирования.
  }
}

/**
 * Строка роутера в тред.
 *
 * Проверено на живых трендах: BB склеивает весь текст ассистента за ход в одно
 * сообщение, поэтому отдельной «пузырь» этим протоколом не сделать —
 * `input.provider` ядро BB не обрабатывает вовсе, а элемент `plan` отбрасывает.
 * Зато текст по каналу `agentMessage`, отправленный сразу при открытии хода,
 * оказывается первой строкой ответа — то есть виден раньше, чем агент успевает
 * что-то сгенерировать, и без участия самого агента.
 */
function messageDeltas(text: string): Record<string, unknown>[] {
  return [
    { kind: "item.textClose", key: { channel: AGENT_CHANNEL }, channel: "agentMessage" },
    { kind: "item.textDelta", key: { channel: AGENT_CHANNEL }, channel: "agentMessage", text },
    { kind: "item.textClose", key: { channel: AGENT_CHANNEL }, channel: "agentMessage" },
  ];
}

/**
 * Отдельное сообщение роутера: харнес, модель, тир, кто платит.
 * `first` — один раз на тред, `always` — каждый ход, `off` — молча.
 */
function announce(threadId: string | undefined, options: CommandOptions): boolean {
  if (!threadId) return false;
  const providerOptions = options.providerOptions ?? {};
  const mode = providerOptions["routerAnnounce"];
  const header = providerOptions["routerHeader"];
  if (mode === "off" || typeof header !== "string" || header.length === 0) return false;
  if (mode !== "always" && announced.has(threadId)) return false;
  announced.add(threadId);
  io.send({
    jsonrpc: "2.0",
    method: DELTA_METHOD,
    params: { threadId, deltas: messageDeltas(header) },
  });
  return true;
}

/**
 * Пикер моделей. Сам ACP-бридж отвечает на `model/list` моделями агента, из-за
 * чего в пикере не видно наших тиров. Отвечаем сами и дальше запрос не пропускаем.
 * Список держим и здесь: `model/list` — каталожная команда, providerOptions у неё
 * может отсутствовать, поэтому полагаться только на них нельзя.
 */
/** Метка харнеса в реестре → id провайдера в BB. */
const HARNESS_PROVIDER: Record<string, string> = {
  omp: "acp-omp",
  hermes: "acp-hermes-agent",
  opencode: "acp-opencode",
};

/**
 * Строки пикера для конкретных моделей короткого списка.
 *
 * BB принимает смену модели треда только если значение есть в каталоге
 * провайдера, и **хранит именно его** — поэтому id строки равен настоящему id
 * модели. В имени показываем харнес, который её запускает: так выбранная пара
 * становится видна в интерфейсе.
 */
function modelRows(): Record<string, unknown>[] {
  const tiers = (
    shortlistJson as {
      tiers: Record<string, { model: string; purpose: string; idsByHarness: Record<string, string[]> }[]>;
    }
  ).tiers;
  const seen = new Map<string, Record<string, unknown>>();
  for (const entries of Object.values(tiers)) {
    for (const entry of entries) {
      for (const [label, ids] of Object.entries(entry.idsByHarness)) {
        const provider = HARNESS_PROVIDER[label];
        if (!provider) continue; // pi роутер не запускает: он не говорит на ACP
        for (const id of ids) {
          if (id.includes(":batch")) continue;
          const existing = seen.get(id);
          if (existing) {
            // Один id может стоять в нескольких харнесах — соберём все метки.
            const labels = new Set(String(existing.displayName).split(" · ")[0]!.split(", "));
            labels.add(provider);
            existing.displayName = `${[...labels].join(", ")} · ${id}`;
            continue;
          }
          seen.set(id, {
            id,
            model: id,
            displayName: `${provider} · ${id}`,
            description: entry.purpose,
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
          });
        }
      }
    }
  }
  return [...seen.values()];
}

const TIER_ROWS: Record<string, unknown>[] = [
  ["auto", "Auto — решить по задаче", "Роутер сам определит тир по тексту задачи"],
  ["frontier", "Frontier — текущие флагманы", "Свежие флагманы OpenAI, Anthropic, Gemini, Grok"],
  ["sub-frontier", "Sub-Frontier — Kimi / DeepSeek / GLM", "Сильные китайские флагманы, обычно по подписке"],
  ["middle", "Middle — рабочие лошадки", "Механические правки, дешёвые рабочие модели"],
  ["low", "Low — дешёвые и бесплатные", "Одноразовые задачи, бесплатные модели"],
].map(([id, displayName, description], index) => ({
  id,
  displayName,
  description,
  model: id,
  isDefault: index === 0,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
}));

function parseTierRows(raw: unknown): Record<string, unknown>[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

interface Rewrite {
  line: string;
  method?: string;
  modelBefore?: unknown;
  modelAfter?: unknown;
  outcome: string;
  threadId?: string;
  options?: CommandOptions;
  rewriteFailed?: boolean;
}

/**
 * Подменить модель команды на ту, что выбрал роутер.
 * Всё неожиданное проходит насквозь: бридж, который падает на незнакомой форме,
 * ломает каждую постороннюю команду.
 */
export function rewriteModelLine(line: string): Rewrite {
  let parsed: Envelope;
  try {
    parsed = JSON.parse(line) as Envelope;
  } catch {
    return { line, outcome: "not-json" };
  }
  const method = parsed.method;
  const params = parsed.params;
  if (!method) return { line, outcome: "no-method" };
  if (!params) return { line, method, outcome: "no-params" };

  const { options, modelBefore, routerModel } = readCommand(params);
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const context = { threadId, options };

  if (method === "model/list") {
      const rows = [...TIER_ROWS, ...modelRows()];
    const id = (parsed as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") {
      io.sendResult(id, { models: rows, scope: "host", selectedOnlyModels: [] });
      return { line, method, outcome: "model-list-local", ...context };
    }
  }

  if (!MODEL_BEARING.has(method)) {
    return { line, method, modelBefore, outcome: "not-model-bearing", ...context };
  }
  if (typeof routerModel !== "string" || routerModel.length === 0) {
    // Решение не пришло: оставляем как есть, но помечаем — это сломанный маршрут.
    return { line, method, modelBefore, outcome: "no-router-model", rewriteFailed: true, ...context };
  }
  parsed.params = { ...params, options: { ...options, model: routerModel } };
  return {
    line: JSON.stringify(parsed),
    method,
    modelBefore,
    modelAfter: routerModel,
    outcome: "rewritten",
    ...context,
  };
}

const bridge = experimental_defineProviderBridge({
  start: (context) => {
    logPath = join(context.dataDir, "bridge.log");
    log({ event: "start", pluginId: context.pluginId, dataDir: context.dataDir });
    experimental_acpProviderBridge.start?.(context);
  },
  handleLine: (line) => {
    const result = rewriteModelLine(line);
    if (result.outcome === "model-list-local") {
      log({ event: "line", method: result.method, outcome: result.outcome });
      return;
    }
    try {
      experimental_acpProviderBridge.handleLine(result.line);
    } catch (error) {
      log({ event: "handleLine-error", message: String(error) });
      throw error;
    }
    // Сообщение уходит ПОСЛЕ бриджа: к этому моменту ход уже открыт, и строка
    // роутера встаёт отдельным сообщением перед выводом агента.
    const didAnnounce =
      result.method && ANNOUNCE_ON.has(result.method) && !result.rewriteFailed
        ? announce(result.threadId, result.options ?? {})
        : false;
    if (result.outcome === "rewritten" || didAnnounce || result.rewriteFailed) {
      log({
        event: "line",
        method: result.method,
        outcome: result.outcome,
        modelBefore: result.modelBefore,
        modelAfter: result.modelAfter,
        announced: didAnnounce,
        threadId: result.threadId,
      });
    }
  },
  onClose: () => {
    log({ event: "close" });
    experimental_acpProviderBridge.onClose?.();
  },
  onSigterm: () => experimental_acpProviderBridge.onSigterm?.(),
  onSigint: () => experimental_acpProviderBridge.onSigint?.(),
});

export { bridge as experimental_providerBridge };
