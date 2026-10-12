/**
 * Дешёвый судья для серой зоны.
 *
 * Правила классификатора срабатывают не всегда. Когда `classify()` вернул
 * `confidence: "low"`, зовём одну короткую модель — но только тогда, и только
 * если это включено в настройках. Судья НЕ выбирает харнес и модель: он отвечает
 * на два вопроса (какие возможности нужны, какой тир), а решение всё равно
 * принимает `decide()`. Так объяснимость не теряется: в журнале видно, что
 * именно сказал судья.
 */

import type { Capability } from "./capabilities";
import type { Tier } from "./tiers";

export interface JudgeVerdict {
  tier: Tier;
  capabilities: Capability[];
  note: string;
}

export type JudgeFn = (task: string) => Promise<JudgeVerdict | null>;

export const JUDGE_CAPABILITIES: Capability[] = [
  "web",
  "browser",
  "browserOwnProfile",
  "computerUse",
  "messaging",
  "cron",
  "delegation",
  "lsp",
  "vision",
  "codeEdit",
];

export const JUDGE_PROMPT = [
  "Ты классифицируешь задачу для роутера агентов. Ответ — только JSON, без пояснений.",
  `Возможности выбирай из списка: ${JUDGE_CAPABILITIES.join(", ")}.`,
  "Тиры: low (одноразовая мелочь), middle (механическая правка), subFrontier (обычная рабочая задача), frontier (архитектура, проектирование, дорогая ошибка).",
  'Формат: {"tier": "<тир>", "capabilities": ["..."], "note": "<до 80 символов, по-русски>"}',
].join("\n");

/** Разбор ответа судьи. Терпим к обёрткам вида ```json … ``` и лишнему тексту. */
export function parseJudgeAnswer(text: string): JudgeVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const tier = obj["tier"];
  if (tier !== "low" && tier !== "middle" && tier !== "subFrontier" && tier !== "frontier") {
    return null;
  }
  const caps = Array.isArray(obj["capabilities"])
    ? (obj["capabilities"] as unknown[]).filter(
        (c): c is Capability => typeof c === "string" && (JUDGE_CAPABILITIES as string[]).includes(c),
      )
    : [];
  const note = typeof obj["note"] === "string" ? obj["note"].slice(0, 120) : "";
  return { tier, capabilities: caps, note };
}

export interface HttpJudgeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Подмена транспорта — для тестов. */
  fetchImpl?: typeof fetch;
}

/**
 * Один вызов OpenAI-совместимого chat/completions. Годится для Z.ai, OpenRouter
 * и любого другого шлюза с тем же протоколом.
 */
export function makeHttpJudge(options: HttpJudgeOptions): JudgeFn {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;

  return async (task: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: JUDGE_PROMPT },
            { role: "user", content: task.slice(0, 4000) },
          ],
          temperature: 0,
          max_tokens: 200,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = body.choices?.[0]?.message?.content;
      return typeof text === "string" ? parseJudgeAnswer(text) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
