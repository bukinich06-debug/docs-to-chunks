import { splitIntoParts } from "@/lib/split";
import { callLLMForChunks } from "./chunkLlmService";
import { mergeChunksSemantically } from "./chunkMergeService";
import {
  extractTextFromFile,
  isDocFile,
  isDocxFile,
  isTextFile,
} from "./chunkFileService";

/** Max tokens of document text per LLM request. */
const MAX_TOKENS_PER_REQUEST = 1500;

/** Ошибка бизнес-логики с кодом для маппинга в HTTP-статус. */
export class ChunkError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 500
  ) {
    super(message);
    this.name = "ChunkError";
  }
}

export interface IChunkDocumentResult {
  partsWithChunks: { part: string; chunks: string[] }[];
}

/**
 * Извлекает текст из файла, разбивает на части, для каждой части запрашивает чанки у LLM (Ollama или vLLM по LLM_BACKEND),
 * постобрабатывает и возвращает результат. Выбрасывает ChunkError при ошибках валидации или LLM.
 */
export async function chunkDocument(file: File): Promise<IChunkDocumentResult> {
  if (!isTextFile(file) && !isDocxFile(file) && !isDocFile(file)) {
    throw new ChunkError("Файл должен иметь расширение .txt, .docx или .doc.", 400);
  }

  let text: string;
  try {
    text = await extractTextFromFile(file);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Не удалось прочитать файл.";
    throw new ChunkError(msg, 400);
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new ChunkError("Файл пуст", 400);
  }

  const parts = splitIntoParts(trimmed, MAX_TOKENS_PER_REQUEST);
  const partsWithChunks: { part: string; chunks: string[] }[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const runs: string[][] = [];

    for (let run = 0; run < 3; run++) {
      let chunks: string[];
      try {
        chunks = await callLLMForChunks(part);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Не удалось сгенерировать фрагменты.";
        throw new ChunkError(message, 500);
      }
      runs.push(chunks);
    }

    let mergedChunks: string[];
    try {
      mergedChunks = await mergeChunksSemantically(runs);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось объединить фрагменты кода.";
      throw new ChunkError(message, 500);
    }
    partsWithChunks.push({ part, chunks: mergedChunks });
  }

  return { partsWithChunks };
}
