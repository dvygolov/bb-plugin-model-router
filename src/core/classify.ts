/**
 * Слой 1: задача → требуемые возможности и предпочтительный тир.
 *
 * Всё детерминировано и объяснимо: каждое сработавшее правило попадает в журнал.
 * Если не сработало ни одно правило кода/веба/браузера — confidence "low",
 * и вызывающая сторона может (не обязана) спросить дешёвую LLM-судью.
 */

import type { Capability } from "./capabilities";
import type { Tier } from "./tiers";

export interface TaskSignals {
  text: string;
  /** Сколько изображений приложено к сообщению. */
  images?: number;
  /** Тред создаётся в каталоге git-репозитория. */
  inRepo?: boolean;
}

export interface RuleHit {
  rule: string;
  capability?: Capability;
  tier?: Tier;
  matched: string;
  note: string;
}

export interface Classification {
  requires: Capability[];
  tier: Tier;
  reasons: RuleHit[];
  confidence: "high" | "low";
}

interface CapabilityRule {
  rule: string;
  capability: Capability;
  re: RegExp;
  note: string;
}

const CAPABILITY_RULES: CapabilityRule[] = [
  {
    rule: "web.search",
    capability: "web",
    re: /(найди в интернете|поищи в сети|погугли|загугли|спарси|спарсь|поищи информаци|что нового|актуальн(ые|ая) (цен|курс|новост)|сравни цены|\bscrape\b|look ?up|web ?search|поищи в интернете)/i,
    note: "нужен доступ в интернет",
  },
  {
    rule: "web.url",
    capability: "web",
    re: /https?:\/\/[^\s]+/i,
    note: "в задаче есть ссылка",
  },
  {
    rule: "browser.own",
    capability: "browserOwnProfile",
    re: /(в мо(ё|е)м браузере|в моих вкладках|под моим аккаунтом|где я залогинен|залогиненн(ый|ом) профил)/i,
    note: "нужен браузер с вашим профилем",
  },
  {
    rule: "browser.drive",
    capability: "browser",
    re: /(открой (сайт|страниц|вкладк)|зайди на сайт|авторизуйся|залогинься|нажми на|кликни|заполни форму|в браузере)/i,
    note: "нужно управлять браузером",
  },
  {
    rule: "computer.use",
    capability: "computerUse",
    re: /(скриншот|мыш(ь|ью)|кликни по|в приложении|в 1[Сс]|в excel|десктопн|gui|по координатам|через графический интерфейс)/i,
    note: "нужно управлять рабочим столом",
  },
  {
    rule: "messaging",
    capability: "messaging",
    re: /(telegram|телеграм|whatsapp|вотсап|discord|slack|отправь (сообщение|в )|напиши в (чат|телеграм|группу)|скинь в (чат|телеграм))/i,
    note: "нужно отправить наружу через мессенджер",
  },
  {
    rule: "cron",
    capability: "cron",
    re: /(каждый день|каждый час|ежедневно|по расписанию|раз в неделю|cron|напоминай|регулярно проверяй)/i,
    note: "нужно расписание",
  },
  {
    rule: "delegation",
    capability: "delegation",
    re: /(параллельн|раздели на \d|несколько агент|воркер|делегируй|распараллель)/i,
    note: "нужны параллельные подзадачи",
  },
  {
    rule: "lsp",
    capability: "lsp",
    re: /(отрефактори|рефакторинг|переименуй во вс(е|ём)|найди все использовани|где определ(ён|ен|ена)|диагностик|типизац|предупреждени[яй] (компилятор|type))/i,
    note: "нужна работа с символами кода",
  },
  {
    rule: "vision",
    capability: "vision",
    re: /(на картинке|на скрине|на изображении|что на фото)/i,
    note: "нужно разобрать изображение",
  },
  {
    rule: "code",
    capability: "codeEdit",
    re: /(код|репозитор|файл|баг|тест|сборк|git|коммит|функци|класс|скрипт|модул|верстк|рефактор|ошибк)/i,
    note: "работа с кодом в репозитории",
  },
];

interface TierRule {
  rule: string;
  tier: Tier;
  re: RegExp;
  note: string;
}

/** Порядок важен: сначала явные просьбы, потом признак силы, потом тривиальность. */
const TIER_RULES: TierRule[] = [
  {
    rule: "tier.explicit.frontier",
    tier: "frontier",
    re: /(лучшую модель|самую умную|максимальн(ое|ый) качеств|не экономь|думай как следует|подумай хорошенько|opus|gpt-?[56]|claude (opus|sonnet))|\bопус\b/i,
    note: "вы явно попросили сильнейшую модель",
  },
  {
    rule: "tier.hard",
    tier: "frontier",
    re: /(спроектируй|архитектур|продумай стратег|сложн(ая|ый) (задач|баг)|миграц|системн(ый|ая) (дизайн|проблем)|оптимизируй производительн|разберись, почему|найди корневую причину)/i,
    note: "признаки задачи, где ошибка дорога",
  },
  {
    rule: "tier.throwaway",
    tier: "low",
    re: /(чернов(ой|ик)|не жалко|на скорую руку|просто проверь механику|нужен самый деш(ё|е)вый|быстр(о|енько) набросай)/i,
    note: "явно одноразовая работа",
  },
  {
    rule: "tier.trivial",
    tier: "middle",
    re: /(опечатк|переименуй|поправь форматирование|отформатируй|добавь комментар|переведи (слово|строку)|поправь пробел|приведи в порядок импорты|замени строку)/i,
    note: "механическая правка",
  },
];

export function classify(signals: TaskSignals): Classification {
  const text = signals.text ?? "";
  const reasons: RuleHit[] = [];
  const requires = new Set<Capability>();

  for (const r of CAPABILITY_RULES) {
    const m = r.re.exec(text);
    if (m) {
      requires.add(r.capability);
      reasons.push({
        rule: r.rule,
        capability: r.capability,
        matched: m[0].trim(),
        note: r.note,
      });
    }
  }

  if ((signals.images ?? 0) > 0) {
    requires.add("vision");
    reasons.push({
      rule: "vision.attachment",
      capability: "vision",
      matched: `${signals.images} изображени(е|я)`,
      note: "к задаче приложено изображение",
    });
  }

  if (signals.inRepo && requires.has("codeEdit")) {
    reasons.push({
      rule: "code.inRepo",
      matched: "каталог git-репозитория",
      note: "подтверждает работу с кодом",
    });
  }

  // Тир: берём самое сильное совпадение по порядку правил.
  let tier: Tier = "subFrontier";
  let tierFound = false;
  for (const r of TIER_RULES) {
    const m = r.re.exec(text);
    if (m) {
      tier = r.tier;
      tierFound = true;
      reasons.push({
        rule: r.rule,
        tier: r.tier,
        matched: m[0].trim(),
        note: r.note,
      });
      break;
    }
  }
  if (!tierFound) {
    reasons.push({
      rule: "tier.default",
      tier: "subFrontier",
      matched: "—",
      note: "по умолчанию подписочный Sub-Frontier: Kimi, DeepSeek, GLM",
    });
  }

  // Смешанные задачи: код + браузер одновременно → нужен харнес, умеющий и то и то.
  if (requires.has("codeEdit") && (requires.has("browser") || requires.has("web"))) {
    reasons.push({
      rule: "mixed.codeAndWeb",
      matched: "код + веб",
      note: "нужен харнес с обоими наборами (omp)",
    });
  }

  const capabilityHits = reasons.filter((r) => r.capability).length;
  const confidence: Classification["confidence"] =
    capabilityHits === 0 ? "low" : "high";

  return { requires: [...requires], tier, reasons, confidence };
}
