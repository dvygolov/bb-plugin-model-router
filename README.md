# bb-plugin-model-router

A [BB](https://github.com/get-bb/bb) plugin that decides **once per thread** which
coding agent to run and which model to run it on: capabilities first, then
subscriptions, then quality tier.

It registers a provider called **Router (auto)**. You create a thread the usual
way, pick Router, describe the task — and the router picks the harness
(`acp-omp`, `acp-hermes-agent`, `acp-opencode`) and the model, then hands the turn
to that agent. Nothing switches mid-thread. Its model picker lists the four tiers
plus `auto`, so you can also force a tier by hand.

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

A vendor can be spelled with `/` or with `:` — Hermes uses the colon form
(`kimi-oauth:k3`, `openai-codex:gpt-6-sol`), and reading only `/` made
`kimi-oauth:k3` resolve to *no family*, drop out of Sub-Frontier, and let the
weaker `kimi-for-coding` win the slot silently. Both separators are read now.

Frontier is deliberate about *current* flagships: `o3-mini`, `o4-mini`,
`gpt-oss-120b` and `claude-sonnet-4.6` are **not** Frontier, because the version
floor for a Frontier family is configurable and these sit below it. A
class marker (`-mini`, `-flash`, `-lite`, `-haiku`, `:free`, …) demotes one step.

When the deterministic rules find nothing (`confidence: low`) and a judge is
configured, one cheap model call answers two questions — which capabilities and
which tier — and the same `decide()` still makes the pick. The judge never
chooses the harness or the model.

## The model registry

`src/core/registry.json` is one canonical model → how it is named in every
harness, its tier, context window and what it is for. It is generated, not
hand-written:

```bash
node tools/build-registry.mjs --markdown   # registry.json + docs/models.md
bb route models                            # tiers, context, which harnesses have it
bb route models kimi-k3                    # one model: its names in each harness
bb route models "kimi-oauth:k3"            # look up by a harness-specific id
```

533 canonical models across `pi`, `omp`, `hermes` and `opencode`; 325 carry a
vendor description, from which the strengths tags are parsed (code, agentic,
reasoning, images, long context, speed, cheapness).

**Tiers are concrete models, not families.** `frontierModels` and
`subFrontierModels` are settings holding canonical names, so the boundary moves
without a republish:

```bash
bb plugin config model-router set frontierModels '["gpt-6.1-sol-pro","claude-opus-5.5","kimi-k3", …]'
bb plugin reload model-router
```

The family/marker rules in `tiers.ts` survive only as a fallback for models the
registry has never seen. Resolution is a table lookup — no name parsing, which is
what silently broke twice before (once dropping `kimi-oauth:k3` out of
Sub-Frontier, once reading a date as a version number).

## The algorithm

1. Take every model in the catalogs of the allowed harnesses.
2. Drop every vendor that currently has no headroom — an exhausted subscription
   takes *all* of its models out, not just one.
3. From what is left, filter by what the task needs: input modalities (an attached
   image means a text-only model is not a candidate) and the capability rules.
4. Pick by cost, then hand the thread to a harness that can run the model.

Cost is one number: `funding_cost + tiers_away`. Subscriptions cost nothing, so a
subscription one tier away still beats credits at the requested tier; free models
sit between subscriptions and paid credits so they cannot outrank a proper model
for real work. Ties go to the stronger model.

**OpenAI's codenames are the four tiers.** The ladder is one name per tier, so a
codename never needs a hand-written list entry:

| Codename | Tier |
| --- | --- |
| `astra` | Frontier |
| `sol` | Sub-Frontier |
| `terra` | Middle |
| `luna` | Low |

`gpt-5.6-luna` is therefore a Low-tier model, well below `deepseek-v4-pro` — the
router used to file it under Sub-Frontier, which is why it turned up for work it
should not have been given. Anthropic follows the same idea: Opus is Frontier,
Sonnet and the previous Opus are Sub-Frontier.

**Every window counts.** A vendor has several ceilings at once: OpenCode Go has a
five-hour, a weekly and a monthly one; Kimi has five-hour and weekly; Z.ai has
five-hour and monthly. Hitting *any* of them closes the whole vendor — all of its
models — and the decision names the window that is binding and when it frees up:

```
opencode-go  live
    5 hour       0%
    Weekly       0%
    Monthly    100%  исчерпано  сброс 2026-10-22T08:30:33.000Z
```

One subscription lives under several names — Kimi is `kimi-coding` in pi,
`kimi-code` in omp, `kimi-oauth` in hermes, `kimi-for-coding-oauth` in opencode —
so the live windows are fanned out across all of them rather than leaving some
paths on the static numbers. BB reports OpenCode Go under the provider id
`acp-opencode`, which maps to the `opencode-go` model prefix; before that mapping
existed, Go's exhaustion was recorded under a key no model matches and was
invisible to the router.

Live limits are what makes step 2 real: BB's own collector covers the providers it
knows, and Z.ai, Kimi and OpenRouter come from the `extra-usage` plugin over
cross-plugin RPC — Z.ai's limit is a *five-hour* window, which a static "16% this
month" could never see. Both are re-read before every decision and once a minute.
As a backstop, a 429 blocks that vendor until the reset time the provider itself
reported.

## Where the money goes

Subscriptions are spent first, credits last, and this is explicit rather than
implied by a score:

| Order | Source | Why here |
| --- | --- | --- |
| 1 | `subscription`, `oauth-plan` | already paid for; the whole point of the router |
| 2 | `free` | genuinely free |
| 3 | `api-key` | per token on a Google/Groq key |
| 4 | `credits` | OpenRouter, the only source that bills in real time |

An exhausted subscription is not a candidate at all — it is skipped, and the
decision says so. When every subscription in a tier is exhausted, the **same
tier** is served from OpenRouter credits rather than dropping a level, and the
decision reads *"Подписки в этом тире исчерпаны — берём OpenRouter (кредиты)"*.
Descending a tier happens only when the tier has nothing live in it at all.

## Requirements degrade instead of failing

A classifier can ask for the impossible. "Screenshot" once pulled in
`computerUse` while the attached image pulled in `vision`, and no harness has
both — the decision threw and the turn never started.

Three rules now keep that from happening:

- an attached image no longer implies `computerUse`; only real desktop actions
  do ("click with the mouse", "in the app", "by coordinates");
- requirements are relaxed one group at a time (`computerUse`, then the domain
  capabilities, then `vision`, then `codeEdit`) until some harness qualifies, and
  the decision says which group was dropped;
- if nothing qualifies at all, the router takes the best available option and
  says so, rather than refusing to work.

And an exhausted subscription is never chosen as a silent last resort: when every
candidate of a tier is dead, that tier is skipped (and the decision says so)
instead of launching a thread that is guaranteed to fail.

## Modalities

A model that cannot read an image is not a candidate for a task that carries one,
however strong or cheap it is. Every registry entry carries its input modalities,
and the router filters on them:

```
$ bb route explain "разбери скриншот"
модель: zai:glm-5.3                      ← текстовая, картинки не приложено

$ bb route explain --image "разбери скриншот"
модель: opencode-go:gpt-5.6-luna         ← умеет image, подписка OpenCode Go
причины: Требуются модальности: image
```

Two details this needed:

- Attachments do not arrive in the queued message — they arrive in the turn input
  as a `localImage` block. The router reads them in the `message.dispatch` hook,
  which runs before the provider is started, so the decision is corrected in time.
- When no candidate has *confirmed* modalities, the router falls back to models
  whose modalities are unknown and says so in the decision reasons, rather than
  refusing to work at all.

`bb route shortlist` prints each entry's modalities: `[file+image]`,
`[audio+file+image+video]`, `[только текст]`.

## The shortlist

A tier can hold five hundred models; choosing among all of them is unpredictable.
`src/core/shortlist.json` is a hand-curated list per tier — 22 entries — and the
router picks **only** from it. A new flagship does not enter the choice until you
put it there.

```bash
bb route shortlist        # every entry: purpose, harnesses, who pays, dead vendors
node tools/build-shortlist.mjs   # rebuild; a typo or a vanished model fails loudly
```

Each entry carries a purpose, so the list explains itself: `glm-5.3` is "the main
working model on the Z.ai subscription", `kimi-k2.7-code` is "coding on the Kimi
subscription", `nemotron-3.5-lightning-free` is "free and fast".

Sources are stated, not implied — every entry is validated against the registry,
and the CLI prints which wallet pays for it and whether that wallet is dead:

```
$ bb route shortlist
subFrontier:
  glm-5.3                        Z.ai по подписке, 1M — основная рабочая модель
      pi, omp, hermes, opencode · платит: opencode-go 100% / zai 16%
```

If the shortlist has no candidate for a tier (model gone, everything blocked), the
router falls back to the full catalog and says so in the decision reasons.

## The choice shows up in the composer

The picker offers five rows — `auto` plus the four tiers — and nothing else. The
concrete models are returned as `selectedOnlyModels`, BB's own mechanism for a
model that is shown because the thread has it selected; that keeps eighty
duplicate-looking rows out of the list while still letting BB accept the switch.

Once the router decides, the composer reads the model and the harness that runs
it:

```
GLM-5.3 · omp                    (запускает acp-omp · Z.ai по подписке, 1M)
```

An earlier version printed `acp-omp, acp-opencode · zai/glm-5.3-Flash` — every
harness that owns the id, joined with commas, plus the raw id. The name is now
the model's, and the harness a short suffix.

After the router decides, the thread's model switches to the real one, so the
picker reads **`acp-omp · kimi-code/k3`** instead of `auto`. The catalog therefore
offers, besides the five tier rows, one row per concrete model in the shortlist,
named `<harness> · <model id>`.

Two facts this rests on, both learned from BB's own answers:

- BB validates a thread's model against the provider catalog and stores the value
  it finds there — so the row's id has to *be* the model id (`zai/glm-5.3`), not a
  pointer to it.
- The **provider** cannot be switched on a live thread. BB refuses outright:
  *"Model … is not available in this thread's router model catalog. Choose a model
  offered by router; changing providers requires starting a new thread."* So the
  thread stays on `Router (auto)` and the harness travels in the model row's name.

A useful side effect: picking `acp-hermes-agent · zai:glm-5.3` from the picker
pins exactly that pair and skips the router's own choice.

## Seeing the choice in chat

The thread's first reply starts with one line naming what the router picked:

```
🧭 Router → acp-hermes-agent · kimi-oauth:kimi-for-coding (subFrontier, kimi-oauth)
```

`announce` controls it: `first` (default), `always`, `off`.

The plugin posts it as **its own message**, before the agent has produced a token —
verified: the thread shows two messages, the router's and then the answer.

Two ordering facts this depends on, both found the hard way:

- It is sent on `turn/start`, never on `thread/start`. A delta that arrives before
  the turn is open is dropped; when provisioning took ten seconds between session
  start and the first turn, the note disappeared entirely.
- The picker is answered by this plugin, not by the ACP bridge. The bridge replies
  to `model/list` with a single `acp-default` row ("Model selection is managed by
  the connected ACP agent"), which hid the tiers and made a forced tier impossible.

The line is not written by the agent and does not depend on it obeying a
prompt: the bridge posts it itself, the moment the turn opens and before the
agent's first token. It lands as the **first line of the reply** rather than as a
separate bubble, because BB folds all assistant text of a turn into one message.
Three alternatives were tried against live threads and do not work:

| Attempt | Result |
| --- | --- |
| delta `input.provider` | defined in the protocol, **not handled by BB core** — silently dropped |
| `item.open` with a `plan` item | item is dropped, nothing appears |
| announce on `thread/start` | delta arrives before the turn is open and is dropped |

The working shape is a `textClose` / `textDelta` / `textClose` sequence on the
`agentMessage` channel, sent on `turn/start` once the ACP bridge has opened the
turn. The decision is also stored on the thread, so `bb route why <thread-id>`
works even with announcements off.

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
| `announce` | `first` / `always` / `off` — write the choice into the thread |
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

## Diagnostics

The bridge appends one NDJSON line per command to `<plugin data dir>/bridge-data/bridge.log`:
the method, whether the model was rewritten, and whether the router note went out.
`"outcome":"no-router-model"` there means a routed thread was launched with the
tier label as its model — the bug that made routed threads hang in 0.1.0.

## Development

```bash
bb plugin build .      # dist/server.js + dist/host.js
bb plugin install . --yes
node --test "src/**/*.test.ts"   # 20 checks, no network
```

The decision core in `src/core/` is dependency-free and pure: `decide()` takes
catalogs and quotas and returns a decision with reasons. It is the same code the
standalone `explain` CLI used during design.
