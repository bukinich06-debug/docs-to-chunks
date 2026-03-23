import { callLLMForChunks } from "../chunkLlmService";
import { mergeChunksSemantically } from "../chunkMergeService";
import { ChunkError, type IChunkDocumentResult, type IPartWithChunks } from "../chunkService";
import { IPartInfo } from "./types";

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
export async function chunkParts(parts: IPartInfo[]): Promise<IChunkDocumentResult> {
  if (parts.length === 0) throw new ChunkError("Нет частей текста для обработки.", 400);

  const partsWithChunks: IPartWithChunks[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const runs: string[][] = [];

    try {
      const [chunks1, chunks2, chunks3] = await Promise.all([
        callLLMWithRetry(part.text),
        callLLMWithRetry(part.text),
        callLLMWithRetry(part.text),
      ]);
      
      runs.push(chunks1, chunks2, chunks3);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось сгенерировать фрагменты.";
      throw new ChunkError(message, 500);
    }

    let mergedChunks: string[];
    try {
      mergedChunks = mergeChunksSemantically(runs);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось объединить фрагменты кода.";
      throw new ChunkError(message, 500);
    }

    const { text, ...meta } = part;
    partsWithChunks.push({ part: text, chunks: mergedChunks, ...meta });
  }

  return { partsWithChunks };
}
