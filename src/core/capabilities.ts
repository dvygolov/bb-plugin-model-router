/**
 * Реестр харнесов: что каждый реально умеет и из какого кошелька платит.
 *
 * Источник данных — замер на этой машине 2026-10-12:
 *   pi            — pi.dev, `pi --help` («read, bash, edit, write tools»)
 *   acp-opencode  — opencode 1.18.32, `opencode --help`
 *   acp-omp       — omp v18.2.11, `omp --help` (+ ~/.omp/puppeteer)
 *   acp-hermes-agent — Hermes 0.21.4, `hermes tools list` + docs
 *
 * ВАЖНО: BB не публикует список инструментов провайдера. Каталог провайдера даёт
 * только возможности уровня сессии (permissionModes, supportsFork, ...).
 * Поэтому таблица ниже — декларативная настройка, а не автообнаружение.
 * Правьте её свободно: движок читает её как данные.
 */

export const CAPABILITIES = [
  "bbTools",
  "codeEdit",
  "lsp",
  "modelRoles",
  "web",
  "browser",
  "browserOwnProfile",
  "computerUse",
  "vision",
  "messaging",
  "cron",
  "delegation",
  "memory",
  "fork",
  "rewind",
  "acceptEdits",
  "usageTracking",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Откуда берутся деньги на конкретного вендора внутри харнеса. */
export type Funding =
  | "subscription" // плоская подписка: жечь в первую очередь
  | "oauth-plan" // OAuth-подписка (ChatGPT/Codex) — тоже плоская, но дефицитная
  | "free" // бесплатные модели вендора
  | "credits" // OpenRouter: тратит деньги в реальном времени
  | "api-key"; // платный ключ по токенам

export interface VendorAccess {
  /** Префикс id модели, как он приходит из `bb provider models`. */
  prefix: string;
  funding: Funding;
  /** Что стоит за доступом — попадает в объяснение решения. */
  note?: string;
}

export interface Harness {
  id: string;
  bin: string;
  version: string;
  profile: string;
  capabilities: Capability[];
  vendors: VendorAccess[];
  /** Порядок для ничьих. Меньше — предпочтительнее. */
  tieBreak: number;
  notes?: string;
}

export const HARNESSES: Harness[] = [
  {
    id: "pi",
    bin: "pi",
    version: "pi.dev",
    profile: "код + инструменты BB",
    capabilities: [
      "bbTools",
      "codeEdit",
      "vision",
      "fork",
      "rewind",
    ],
    vendors: [
      { prefix: "kimi-coding", funding: "subscription", note: "Kimi, недельное окно" },
      { prefix: "zai", funding: "subscription", note: "Z.ai, месячное окно" },
      { prefix: "opencode-go", funding: "subscription", note: "OpenCode Go, месячное окно" },
      { prefix: "google", funding: "api-key" },
      { prefix: "groq", funding: "api-key" },
      { prefix: "openrouter", funding: "credits" },
    ],
    tieBreak: 1,
    notes: "единственный с rewind; каталог моделей привязан к workspace",
  },
  {
    id: "acp-opencode",
    bin: "opencode",
    version: "1.18.32",
    profile: "код, LSP, MCP, GitHub/PR",
    capabilities: ["codeEdit", "lsp", "acceptEdits", "usageTracking", "vision", "fork"],
    vendors: [
      { prefix: "opencode-go", funding: "subscription" },
      { prefix: "kimi-for-coding-oauth", funding: "oauth-plan" },
      { prefix: "zai", funding: "subscription" },
      { prefix: "opencode", funding: "free", note: "бесплатные модели opencode" },
      { prefix: "google", funding: "api-key" },
      { prefix: "groq", funding: "api-key" },
      { prefix: "openrouter", funding: "credits" },
    ],
    tieBreak: 3,
    notes: "BB умеет читать его квоты; fork в BB не поддержан",
  },
  {
    id: "acp-omp",
    bin: "omp",
    version: "18.2.11",
    profile: "код + LSP + браузер-релей + веб-поиск + роли моделей",
    capabilities: [
      "codeEdit",
      "lsp",
      "modelRoles",
      "web",
      "browser",
      "browserOwnProfile",
      "vision",
      "fork",
      "acceptEdits",
    ],
    vendors: [
      { prefix: "opencode-go", funding: "subscription" },
      { prefix: "kimi-code", funding: "subscription" },
      { prefix: "zai", funding: "subscription" },
      { prefix: "google", funding: "api-key" },
      { prefix: "groq", funding: "api-key" },
      { prefix: "openrouter", funding: "credits" },
    ],
    tieBreak: 2,
    notes: "web-бэкенды: Exa, Brave, Perplexity, Tavily, TinyFish, Firecrawl; браузер ведёт ваши вкладки Chrome по CDP",
  },
  {
    id: "acp-hermes-agent",
    bin: "hermes",
    version: "0.21.4",
    profile: "универсальный агент: браузер, computer use, мессенджеры, cron, память",
    capabilities: [
      "web",
      "browser",
      "computerUse",
      "vision",
      "messaging",
      "cron",
      "delegation",
      "memory",
      "fork",
      "acceptEdits",
    ],
    vendors: [
      { prefix: "openai-codex", funding: "oauth-plan", note: "OAuth ChatGPT; сейчас exhausted, но живой" },
      { prefix: "kimi", funding: "oauth-plan" },
      { prefix: "zai", funding: "subscription" },
      { prefix: "google", funding: "api-key" },
      { prefix: "openrouter", funding: "credits", note: "весь каталог Hermes идёт с префиксом openrouter:" },
    ],
    tieBreak: 4,
    notes: "единственный с computer_use и мессенджерами; свой счётчик opencode-go ловит 429",
  },
];

/**
 * acp-cursor исключён: `spawn cursor-agent ENOENT` — исполняемого файла нет.
 * Когда появится, добавить с capabilities: ["codeEdit","lsp","acceptEdits","usageTracking","fork"].
 */
export const HARNESSES_UNAVAILABLE = ["acp-cursor"];

export function harnessById(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}

export function hasAll(h: Harness, required: Capability[]): boolean {
  return required.every((c) => h.capabilities.includes(c));
}

export function missing(h: Harness, required: Capability[]): Capability[] {
  return required.filter((c) => !h.capabilities.includes(c));
}
