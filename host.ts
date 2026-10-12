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

import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

/** Methods whose params carry a model that must be resolved before launch. */
const MODEL_BEARING = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
]);

interface Envelope {
  method?: string;
  params?: {
    model?: unknown;
    providerOptions?: Record<string, unknown>;
  };
}

/**
 * Replace `params.model` with the router's resolved model id.
 * Anything unexpected is passed through untouched: a bridge that throws on a
 * shape it does not know would break every unrelated command.
 */
export function rewriteModelLine(line: string): string {
  let parsed: Envelope;
  try {
    parsed = JSON.parse(line) as Envelope;
  } catch {
    return line;
  }
  const method = parsed.method;
  const params = parsed.params;
  if (!method || !params || !MODEL_BEARING.has(method)) return line;

  const routerModel = params.providerOptions?.["routerModel"];
  if (typeof routerModel !== "string" || routerModel.length === 0) return line;

  parsed.params = { ...params, model: routerModel };
  return JSON.stringify(parsed);
}

const bridge = experimental_defineProviderBridge({
  start: (context) => experimental_acpProviderBridge.start?.(context),
  handleLine: (line) => experimental_acpProviderBridge.handleLine(rewriteModelLine(line)),
  onClose: () => experimental_acpProviderBridge.onClose?.(),
  onSigterm: () => experimental_acpProviderBridge.onSigterm?.(),
  onSigint: () => experimental_acpProviderBridge.onSigint?.(),
});

export { bridge as experimental_providerBridge };
