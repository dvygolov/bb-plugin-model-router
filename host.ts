// bb-plugin-model-router — host entry.
//
// It ships the provider bridge for the `router` provider: the ACP bridge kit
// handles the whole protocol (opencode / omp / hermes all speak ACP), and this
// wrapper does exactly one thing on top of it — rewrites the model id of a
// command before the ACP bridge sees it.
//
// Why the rewrite is needed: the generic ACP bridge has no id mapping table —
// whatever model id BB resolved from the picker is what the agent gets. The
// router provider's picker shows tiers (`auto`, `frontier`, …), which are not
// agent model ids, so server.ts decides the real pair (harness + model) and
// passes it per command in providerOptions; here we put it back where the ACP
// bridge reads the model from.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

/** Methods whose params carry a model that must be resolved before launch. */
const MODEL_BEARING = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
]);

interface CommandOptions {
  model?: unknown;
  instructions?: unknown;
  providerOptions?: Record<string, unknown>;
}

const MARKER = "🧭 Router";

/**
 * Вклеить объявление выбора в инструкции треда.
 *
 * Инструкции фиксируются при создании сессии — а решение по задаче считается
 * отдельным событием, поэтому plugin-хук dynamic instructions на первом ходу
 * успевает не всегда. Здесь решение уже пришло вместе с командой, так что
 * вставка гарантирована. Повторно не вставляем.
 */
function withRouterSection(options: CommandOptions): CommandOptions {
  const providerOptions = options.providerOptions ?? {};
  const announce = providerOptions["routerAnnounce"];
  const header = providerOptions["routerHeader"];
  const instructions = String(options.instructions ?? "");
  if (announce === "off" || typeof header !== "string" || instructions.includes(MARKER)) {
    return options;
  }
  const when =
    announce === "always"
      ? "Первой строкой каждого ответа выводи ровно эту строку, без изменений:"
      : "Первой строкой своего первого ответа в этом треде выведи ровно эту строку, без изменений:";
  const section = [
    "",
    "# Выбор роутера",
    "Харнес и модель для этого треда выбрал плагин model-router — один раз, при создании треда.",
    "Сам ты их не меняешь: если просят другую модель, скажи использовать /model.",
    `${when} ${header}`,
  ].join("\n");
  return { ...options, instructions: `${instructions}${section}` };
}

interface Envelope {
  method?: string;
  params?: {
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
  source: "options" | "params" | "none";
} {
  const options = params.options ?? {};
  if (params.options) {
    return {
      options,
      modelBefore: options.model,
      routerModel: options.providerOptions?.["routerModel"],
      source: "options",
    };
  }
  return {
    options,
    modelBefore: params.model,
    routerModel: params.providerOptions?.["routerModel"],
    source: params.providerOptions ? "params" : "none",
  };
}

/** Диагностика: одна строка NDJSON на команду, рядом с данными плагина. */
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

interface Rewrite {
  line: string;
  method?: string;
  modelBefore?: unknown;
  modelAfter?: unknown;
  outcome: string;
  announced?: boolean;
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
  if (!MODEL_BEARING.has(method)) {
    return { line, method, modelBefore, outcome: "not-model-bearing" };
  }
  if (typeof routerModel !== "string" || routerModel.length === 0) {
    return { line, method, modelBefore, outcome: "no-router-model" };
  }
  parsed.params = { ...params, options: withRouterSection({ ...options, model: routerModel }) };
  const instructionsBefore = String((options as { instructions?: unknown }).instructions ?? "");
  return {
    line: JSON.stringify(parsed),
    method,
    modelBefore,
    modelAfter: routerModel,
    outcome: "rewritten",
    announced: !instructionsBefore.includes(MARKER),
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
    if (result.outcome === "rewritten" || result.outcome === "no-router-model") {
      log({
        event: "line",
        method: result.method,
        outcome: result.outcome,
        modelBefore: result.modelBefore,
        modelAfter: result.modelAfter,
        announced: result.announced,
      });
    }
    try {
      experimental_acpProviderBridge.handleLine(result.line);
    } catch (error) {
      log({ event: "handleLine-error", message: String(error) });
      throw error;
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
