/**
 * Реестр моделей: одна каноническая модель → как она называется в каждом
 * харнесе, к какому классу относится, сколько держит контекста и что умеет.
 *
 * Зачем вместо разбора имени регулярками: разбор уже дважды ошибся молча
 * (`kimi-oauth:k3` вылетал из Sub-Frontier, даты в имени читались как версия).
 * Таблица предсказуема, правится руками и ищется за O(1) — а скорость выбора
 * здесь важна, решение принимается на пути отправки сообщения.
 *
 * Файл `registry.json` генерируется `node tools/build-registry.mjs`.
 */

import raw from "./registry.json";

export interface RegistryEntry {
  canonical: string;
  family: string | null;
  tier: "low" | "middle" | "subFrontier" | "frontier";
  tierSource: string;
  harnesses: Record<string, string[]>;
  contextLength: number | null;
  modalities: string[];
  strengths: string[];
  description: string | null;
}

interface Registry {
  generatedAt: string;
  harnesses: string[];
  models: Record<string, RegistryEntry>;
}

const registry = raw as unknown as Registry;

/** id как он есть в харнесе → каноническая модель и тир. */
const byId = new Map<string, { canonical: string; tier: RegistryEntry["tier"] }>();
const byCanonical = new Map<string, RegistryEntry>();

for (const [canonical, entry] of Object.entries(registry.models)) {
  byCanonical.set(canonical, entry);
  for (const ids of Object.values(entry.harnesses)) {
    for (const id of ids) byId.set(id, { canonical, tier: entry.tier });
  }
}

/**
 * Переопределения из настроек: списки канонических моделей, которые владелец
 * относит к Frontier и Sub-Frontier. Пустые списки означают «как в реестре».
 */
function rebuild(frontier: string[], subFrontier: string[]): void {
  const frontierSet = new Set(frontier);
  const subSet = new Set(subFrontier);
  for (const [id, hit] of byId) {
    const entry = byCanonical.get(hit.canonical);
    if (!entry) continue;
    if (frontierSet.has(hit.canonical)) hit.tier = "frontier";
    else if (subSet.has(hit.canonical)) hit.tier = "subFrontier";
    else hit.tier = entry.tier;
  }
  for (const [canonical, entry] of byCanonical) {
    if (frontierSet.has(canonical)) byCanonical.set(canonical, { ...entry, tier: "frontier" });
    else if (subSet.has(canonical)) byCanonical.set(canonical, { ...entry, tier: "subFrontier" });
    else byCanonical.set(canonical, { ...entry, tier: registry.models[canonical]!.tier });
  }
}

export function applyTierOverrides(frontier: string[], subFrontier: string[]): void {
  rebuild(frontier, subFrontier);
}

/** Тир по id конкретного харнеса. Возвращает null, если модели нет в реестре. */
export function lookupTier(id: string): { canonical: string; tier: RegistryEntry["tier"] } | null {
  return byId.get(id) ?? null;
}

export function registryEntry(canonical: string): RegistryEntry | null {
  return byCanonical.get(canonical) ?? null;
}

export function allEntries(): RegistryEntry[] {
  return [...byCanonical.values()];
}

export function generatedAt(): string {
  return registry.generatedAt;
}

export function harnessNames(): string[] {
  return registry.harnesses;
}

/**
 * Модальности модели по id конкретного харнеса. null — данных нет, и тогда
 * вызывающий решает сам, рискнуть или отказаться.
 */
export function modalitiesForId(id: string): string[] | null {
  const hit = byId.get(id);
  if (!hit) return null;
  const mods = byCanonical.get(hit.canonical)?.modalities ?? [];
  return mods.length > 0 ? mods : null;
}

/** Конкретные id модели во всех харнесах. */
export function idsForCanonical(canonical: string): string[] {
  const entry = byCanonical.get(canonical);
  if (!entry) return [];
  return Object.values(entry.harnesses).flat();
}

/**
 * Короткий список: канонические имена → конкретные id, которые сравнивает
 * роутер. Отсюда же видно, какие записи вообще не нашлись в каталогах.
 */
export function shortlistIds(canonicals: string[]): string[] {
  return canonicals.flatMap(idsForCanonical);
}

/** Человекочитаемая карточка модели: тир, контекст, назначение, имена в харнесах. */
export function describe(canonical: string): string | null {
  const entry = byCanonical.get(canonical);
  if (!entry) return null;
  const lines = [
    `${entry.canonical}  ·  ${entry.tier}  ·  ${
      entry.contextLength ? `${Math.round(entry.contextLength / 1000)}k контекста` : "контекст неизвестен"
    }`,
    `умеет: ${entry.strengths.length ? entry.strengths.join(", ") : "не размечено"}`,
  ];
  if (entry.description) lines.push(`о модели: ${entry.description}`);
  lines.push("имена в харнесах:");
  for (const [harness, ids] of Object.entries(entry.harnesses)) {
    lines.push(`  ${harness.padEnd(9)} ${ids.join(", ")}`);
  }
  return lines.join("\n");
}
