import { splitIntoParts } from "@/lib/split";
import { callLLMForChunks } from "./chunkLlmService";
import { mergeChunksSemantically } from "./chunkMergeService";
import {
  extractTextFromFile,
  isDocFile,
  isDocxFile,
  isTextFile,
} from "./chunkFileService";

/** Максимум токенов текста документа на один запрос к LLM. */
const MAX_TOKENS_PER_REQUEST = 1500;

/** Один запрос к LLM с повтором при ошибке: в консоль пишем ошибку и вызываем ещё раз. */
async function callLLMWithRetry(part: string): Promise<string[]> {
  try {
    return await callLLMForChunks(part);
  } catch (err) {
    console.error("[chunk] Ошибка запроса к LLM, повтор:", err instanceof Error ? err.message : err);
    return await callLLMForChunks(part);
  }
}

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

export interface IPartWithChunks {
  part: string;
  chunks: string[];
  chapter?: string;
  subsection?: string;
  page_range?: [number, number];
}

export interface IChunkDocumentResult {
  partsWithChunks: IPartWithChunks[];
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
  if (!trimmed) throw new ChunkError("Файл пуст", 400);
  

  const parts = splitIntoParts(trimmed, MAX_TOKENS_PER_REQUEST);
  const partsWithChunks: IPartWithChunks[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const runs: string[][] = [];
    try {
      const [chunks1, chunks2, chunks3] = await Promise.all([
        callLLMWithRetry(part),
        callLLMWithRetry(part),
        callLLMWithRetry(part),
      ]);
      runs.push(chunks1, chunks2, chunks3);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось сгенерировать фрагменты.";
      throw new ChunkError(message, 500);
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
