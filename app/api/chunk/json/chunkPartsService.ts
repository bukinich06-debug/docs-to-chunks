import { callLLMForChunks } from "../chunkLlmService";
import { mergeChunksSemantically } from "../chunkMergeService";
import { ChunkError, type IChunkDocumentResult } from "../chunkService";

async function callLLMWithRetry(part: string): Promise<string[]> {
  try {
    return await callLLMForChunks(part);
  } catch (err) {
    console.error("[chunk] Ошибка запроса к LLM, повтор:", err instanceof Error ? err.message : err);
    return await callLLMForChunks(part);
  }
}

/**
 * Для каждой части текста — три прогона LLM и семантическое объединение.
 */
export async function chunkParts(parts: string[]): Promise<IChunkDocumentResult> {
  if (parts.length === 0) throw new ChunkError("Нет частей текста для обработки.", 400);

  const partsWithChunks: { part: string; chunks: string[] }[] = [];

  // for (let i = 0; i < parts.length; i++) {
    const part = parts[1];
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
  // }

  return { partsWithChunks };
}
