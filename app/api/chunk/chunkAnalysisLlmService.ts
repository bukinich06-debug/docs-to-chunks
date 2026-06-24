import { getRawResponseFromLLM } from "./chunkLlmService";
import type { ICoverageAnalysisResult } from "./chunkAnalysisTypes";

const MAX_INVALID_JSON_RETRIES = 3;

const COVERAGE_ANALYSIS_INSTRUCTION = `Ты проверяешь полноту покрытия исходного текста раздела документации сгенерированными чанками для RAG-поиска.

Задача: сравни ИСХОДНЫЙ ТЕКСТ РАЗДЕЛА с ПОЛУЧЕННЫМИ ЧАНКАМИ и оцени, какой процент полезной для пользователя информации из раздела отражён в чанках.

Критерии «полезной информации» (должна быть в чанках, если есть в исходнике):
- Определения, сокращения, пояснения терминов
- Инструкции, процедуры, пошаговые действия
- Условия, ограничения, правила, требования
- Описания полей, кнопок, элементов интерфейса и их назначения
- Сжатые перефразировки содержимого изображений, если описание нужно для самодостаточного ответа на вопрос

НЕ считай пропуском (намеренно исключается из чанков):
- Подписи и ссылки на рисунки («Рисунок 1», «Рис. 1-1» и т.п.)
- Подписи и ссылки на таблицы («Таблица 18» и т.п.)
- Литералы разметки изображений (⟦img⟧, ⟦/img⟧, ⟦icon⟧, ⟦/icon⟧, атрибуты path/name)
- Технические метаданные документа (даты создания/редактирования, авторы правок)
- Содержание без смысловой важности для ответов пользователю

Правила оценки:
- Сравнивай по смыслу, а не дословно: чанк может перефразировать исходник.
- Не выдумывай факты, которых нет в исходном тексте.
- coveragePercent — целое число от 0 до 100.
- missingTopics — конкретные темы/факты из исходника, не отражённые в чанках (кратко, по пунктам).
- coveredTopics — ключевые темы, которые успешно попали в чанки.
- intentionallyExcluded — что из исходника намеренно не должно быть в чанках (по правилам выше).
- summary — краткий вывод на русском (1–3 предложения).

Ответь СТРОГО одним валидным JSON-объектом в формате:
{
  "coveragePercent": 85,
  "summary": "...",
  "coveredTopics": ["..."],
  "missingTopics": ["..."],
  "intentionallyExcluded": ["..."],
  "notes": "..."
}
Поле notes опционально. Без комментариев до или после JSON.`;

export type AnalysisChunkInput = {
  text: string;
  images?: string[];
};

function buildUserPayload(sourceText: string, chunks: AnalysisChunkInput[]): string {
  const chunksBlock = chunks
    .map((ch, i) => {
      const imagesNote =
        ch.images && ch.images.length > 0
          ? `\n   (изображения: ${ch.images.join(", ")})`
          : "";
      return `${i + 1}. ${ch.text}${imagesNote}`;
    })
    .join("\n\n");

  return `ИСХОДНЫЙ ТЕКСТ РАЗДЕЛА:
---
${sourceText}
---

ПОЛУЧЕННЫЕ ЧАНКИ (${chunks.length}):
---
${chunksBlock}
---`;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCoverageResponse(raw: string): ICoverageAnalysisResult {
  let jsonStr = raw;
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/;
  const m = raw.match(codeBlock);
  if (m) jsonStr = m[1].trim();

  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

  const percentRaw = parsed.coveragePercent;
  const coveragePercent =
    typeof percentRaw === "number"
      ? Math.round(Math.min(100, Math.max(0, percentRaw)))
      : typeof percentRaw === "string"
        ? Math.round(Math.min(100, Math.max(0, Number(percentRaw))))
        : NaN;

  if (Number.isNaN(coveragePercent)) {
    throw new Error("Invalid coveragePercent in LLM response");
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) {
    throw new Error("Missing or empty summary in LLM response");
  }

  const notes =
    typeof parsed.notes === "string" && parsed.notes.trim()
      ? parsed.notes.trim()
      : undefined;

  return {
    coveragePercent,
    summary,
    coveredTopics: parseStringArray(parsed.coveredTopics),
    missingTopics: parseStringArray(parsed.missingTopics),
    intentionallyExcluded: parseStringArray(parsed.intentionallyExcluded),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export async function callLLMForCoverageAnalysis(
  sourceText: string,
  chunks: AnalysisChunkInput[]
): Promise<ICoverageAnalysisResult> {
  const userPayload = buildUserPayload(sourceText, chunks);
  const phase = "analysis" as const;

  for (let attempt = 1; attempt <= MAX_INVALID_JSON_RETRIES; attempt++) {
    let raw: string;
    try {
      raw = await getRawResponseFromLLM(userPayload, COVERAGE_ANALYSIS_INSTRUCTION, phase);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new Error(`LLM request failed at analysis stage: ${message}`);
    }

    try {
      return parseCoverageResponse(raw);
    } catch (parseErr) {
      console.error(
        "[chunkAnalysisLlmService] Failed to parse analysis response. Raw:",
        raw,
        "attempt",
        attempt,
        "of",
        MAX_INVALID_JSON_RETRIES
      );

      if (attempt < MAX_INVALID_JSON_RETRIES) {
        console.warn("[chunkAnalysisLlmService] Retrying due to invalid analysis JSON");
        continue;
      }

      const detail = parseErr instanceof Error ? parseErr.message : "Invalid JSON";
      throw new Error(`LLM did not return valid coverage analysis JSON: ${detail}`);
    }
  }

  throw new Error("Unexpected error while calling LLM for coverage analysis");
}
