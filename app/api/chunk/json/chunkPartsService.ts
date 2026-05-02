import type { OutlineSectionImage } from "@/lib/outlineOutput";
import { callLLMForJsonChunks, type LlmJsonChunkRow } from "../chunkLlmService";
import { mergeChunksSemantically } from "../chunkMergeService";
import { ChunkError } from "../chunkService";
import {
  type IJsonChunkInputItem,
  type IJsonChunkOutputItem,
  type IJsonOutputChunk,
} from "./types";

function getImagePaths(part: IJsonChunkInputItem): string[] {
  return (part.images ?? []).map((im) => im.img.trim()).filter(Boolean);
}

function enrichChunkRow(
  row: LlmJsonChunkRow,
  catalog: OutlineSectionImage[] | undefined
): IJsonOutputChunk {
  const byPath = new Map<string, OutlineSectionImage>();
  for (const im of catalog ?? []) {
    byPath.set(im.img.trim(), im);
  }

  const images: OutlineSectionImage[] = [];
  for (const path of row.images) {
    const meta = byPath.get(path);
    if (meta) {
      if (!images.some((x) => x.img === meta.img)) {
        images.push(meta);
      }
    } else {
      console.warn(
        "[chunkPartsService] No metadata in section for image path:",
        path
      );
    }
  }

  return { text: row.text, images };
}

async function callJsonLlmWithRetry(
  text: string,
  paths: string[]
): Promise<LlmJsonChunkRow[]> {
  try {
    return await callLLMForJsonChunks(text, paths);
  } catch (err) {
    console.error(
      "[chunk] Ошибка запроса к LLM, повтор:",
      err instanceof Error ? err.message : err
    );
    return await callLLMForJsonChunks(text, paths);
  }
}

/**
 * Для каждой части текста — три прогона LLM и семантическое объединение.
 */
export async function chunkParts(
  parts: IJsonChunkInputItem[]
): Promise<IJsonChunkOutputItem[]> {
  if (parts.length === 0) {
    throw new ChunkError("Нет частей текста для обработки.", 400);
  }

  const partsWithChunks: IJsonChunkOutputItem[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const paths = getImagePaths(part);
    const runs: LlmJsonChunkRow[][] = [];

    try {
      const [chunks1, chunks2, chunks3] = await Promise.all([
        callJsonLlmWithRetry(part.text, paths),
        callJsonLlmWithRetry(part.text, paths),
        callJsonLlmWithRetry(part.text, paths),
      ]);

      runs.push(chunks1, chunks2, chunks3);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Не удалось сгенерировать фрагменты.";
      throw new ChunkError(message, 500);
    }

    let mergedRows: LlmJsonChunkRow[];
    try {
      mergedRows = mergeChunksSemantically(runs);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Не удалось объединить фрагменты.";
      throw new ChunkError(message, 500);
    }

    const chunks: IJsonOutputChunk[] = mergedRows.map((row) =>
      enrichChunkRow(row, part.images)
    );

    partsWithChunks.push({
      number: part.number,
      label: part.label,
      title: part.title,
      parents: part.parents,
      sourceText: part.text,
      chunks,
    });
  }

  return partsWithChunks;
}
