# bb-plugin-model-router

A [BB](https://github.com/get-bb/bb) plugin that decides **once per thread** which
coding agent to run and which model to run it on: capabilities first, then
subscriptions, then quality tier.

It registers a provider called **Router (auto)**. You create a thread the usual
way, pick Router, describe the task — and the router picks the harness
(`acp-omp`, `acp-hermes-agent`, `acp-opencode`) and the model, then hands the turn
to that agent. Nothing switches mid-thread.

```
Провайдер: [ Router (auto) ▾ ]
Модель:    [ auto ▾ ]              ← auto | frontier | sub-frontier | middle | low
Задача:    «открой сайт поставщика, залогинься и скачай счёт»

харнес: acp-hermes-agent      (browser automation)
модель: zai/glm-5.3           (подписка Z.ai, 16% израсходовано)
тир:    subFrontier
```

## Install

```bash
bb plugin install https://github.com/dvygolov/bb-plugin-model-router
```

Requires at least one ACP agent on `PATH`: `opencode acp`, `omp acp`, or
`hermes acp`.

## How it decides

Three layers, all of them explainable:

1. **Capabilities** — the task text is matched against deterministic rules
   (`bb route explain "…"` prints every hit). A task that needs a browser can
   only go to a harness that has one; a task that needs `computer_use` goes to
   Hermes and nowhere else.
2. **Wallet** — the harness is scored by where the money comes from:
   `subscription` → `oauth-plan` → `free` → `api-key` → `credits`, minus
   `0.9 × quota_percent`. OpenRouter is always last; an exhausted vendor is
   skipped while any alternative exists.
3. **Tier** — the model is picked from the required tier inside the chosen
   harness's own catalog:

| Tier | Families | Examples |
| --- | --- | --- |
| **Frontier** | current flagships of openai, anthropic, google, x-ai | `gpt-6.1-sol-pro`, `claude-opus-5.5`, `gemini-3.1-pro-preview`, `grok-4.7` |
| **Sub-Frontier** | moonshotai, deepseek, z-ai | `kimi-k3`, `deepseek-v4-pro`, `glm-5.3` |
| **Middle** | minimax, xiaomi, qwen, tencent, meta, nvidia, … | `minimax-m3`, `mimo-v2.6-pro` |
| **Low** | `:free` / `-free`, gemma, llama-3.x, ling | `gemma-4-31b-it:free` |

Frontier is deliberate about *current* flagships: `o3-mini`, `o4-mini`,
`gpt-oss-120b` and `claude-sonnet-4.6` are **not** Frontier, because the version
floor for a Frontier family is configurable and these sit below it. A
class marker (`-mini`, `-flash`, `-lite`, `-haiku`, `:free`, …) demotes one step.

When the deterministic rules find nothing (`confidence: low`) and a judge is
configured, one cheap model call answers two questions — which capabilities and
which tier — and the same `decide()` still makes the pick. The judge never
chooses the harness or the model.

## Seeing the choice in chat

The thread's first reply starts with one line naming what the router picked:

```
🧭 Router → acp-hermes-agent · kimi-oauth:kimi-for-coding (subFrontier, kimi-oauth)
```

`announce` controls it: `first` (default), `always`, `off`. The line is injected
into the thread's instructions by the bridge, because at session construction the
decision is already known there — a plugin-level dynamic-instructions hook can
race the classification on the first turn. The decision is also stored on the
thread, so `bb route why <thread-id>` works even with announcements off.

## Commands

| Command | Effect |
| --- | --- |
| `bb route explain "<task>"` | The decision for a task, with every reason |
| `bb route why [thread-id]` | What was recorded for a thread |
| `bb route harnesses` | Harness registry: capabilities, wallets, launch commands |
| `bb route quota` | Vendor quotas as the router sees them |
| `bb route blocked` | Vendors excluded because their credentials are dead |

## Settings

`bb plugin config model-router set <key> <value>`, then `bb plugin reload model-router`.

| Key | Meaning |
| --- | --- |
| `harnesses` | JSON array of allowed ACP harness ids |
| `launchSpecs` | JSON: the ACP launch command per harness |
| `quotas` | JSON: `{ "zai": { "percent": 16, "window": "monthly" } }` |
| `frontierFloor` | JSON: minimum version per Frontier family |
| `dryRun` | Decide and record, but do not launch |
| `announce` | `first` / `always` / `off` — print the choice in chat |
| `blockedVendors` | JSON array of vendors to skip (dead credentials) |
| `judgeEnabled`, `judgeBaseUrl`, `judgeModel`, `judgeApiKey` | The low-confidence judge (any OpenAI-compatible endpoint) |

## How it works inside BB

- `bb.providers.register` adds the picker entry; its threads run on the ACP
  bridge kit the plugin re-exports from its `bb.host` artifact.
- `deriveProviderOptions` runs on every session and turn command. It is
  synchronous and does no I/O: it reads a decision cached by `threadId` and
  returns the launch spec for the chosen harness.
- `bb.events.on("message.queued")` is where the task is actually classified — off
  the turn-submit path, so a judge call can never delay a message.
- The provider's picker ids are tiers, not agent model ids, so `host.ts` rewrites
  `params.model` from `providerOptions.routerModel` before the ACP bridge sees
  the command. The generic ACP bridge has no id mapping table; this is that table.

## Dead credentials heal themselves

A subscription path can be configured and still be dead — an expired OAuth token
fails at launch, not at routing time. The router cannot see that in advance, so it
reacts: when a turn fails with a credential error, the vendor is added to
`blockedVendors`, the thread's decision is dropped, and the next turn routes
around it. `bb route blocked` shows the list; clear it with
`bb plugin config model-router set blockedVendors "[]"` after fixing the login.

The default ships with `openai-codex` blocked, because Hermes' ChatGPT/Copex OAuth
was expired on the machine this was built against. Re-login with
`hermes auth add openai-codex` and unblock it to spend that subscription.

## Limitations, stated plainly

- **`pi` is not covered.** It speaks its own RPC, not ACP, so it cannot be
  launched through the ACP bridge. Pi threads stay manual for now.
- **The harness capability table is declared, not discovered.** BB does not
  publish a provider's tool list, so `src/core/capabilities.ts` is maintained by
  hand and carries the versions it was verified against (`omp 18.2.11`,
  `hermes 0.21.4`, `opencode 1.18.32`).
- **Model catalogs are a snapshot** (`src/core/catalogs.json`), so a tier can
  miss a model released after it. Refresh and rebuild to update.
- **The decision is final for the thread.** If a task turns out harder than it
  looked, change the model manually — the router will not do it for itself.
- `acp-cursor` is excluded: `cursor-agent` is not installed.

## Development

```bash
bb plugin build .      # dist/server.js + dist/host.js
bb plugin install . --yes
node --test "src/**/*.test.ts"   # 20 checks, no network
```

The decision core in `src/core/` is dependency-free and pure: `decide()` takes
catalogs and quotas and returns a decision with reasons. It is the same code the
standalone `explain` CLI used during design.
