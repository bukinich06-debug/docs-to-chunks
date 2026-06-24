import { ChunkError } from "./chunkService";
import {
  callLLMForCoverageAnalysis,
  type AnalysisChunkInput,
} from "./chunkAnalysisLlmService";
import type { ICoverageAnalysisResult } from "./chunkAnalysisTypes";
import type { IJsonOutputChunk } from "./json/types";

function normalizeChunks(chunks: AnalysisChunkInput[]): AnalysisChunkInput[] {
  return chunks
    .map((ch) => ({
      text: ch.text.trim(),
      images: ch.images?.map((p) => p.trim()).filter(Boolean),
    }))
    .filter((ch) => ch.text.length > 0);
}

async function analyzeCoverage(
  sourceText: string,
  chunks: AnalysisChunkInput[]
): Promise<ICoverageAnalysisResult> {
  const trimmedSource = sourceText.trim();
  if (!trimmedSource) {
    throw new ChunkError("Пустой исходный текст.", 400);
  }

  const normalized = normalizeChunks(chunks);
  if (normalized.length === 0) {
    throw new ChunkError("Нет чанков для анализа.", 400);
  }

  try {
    return await callLLMForCoverageAnalysis(trimmedSource, normalized);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Не удалось выполнить анализ покрытия.";
    throw new ChunkError(message, 500);
  }
}

export async function analyzeDocumentPartCoverage(
  sourceText: string,
  chunks: string[]
): Promise<ICoverageAnalysisResult> {
  return analyzeCoverage(
    sourceText,
    chunks.map((text) => ({ text }))
  );
}

export async function analyzeJsonSectionCoverage(
  sourceText: string,
  chunks: IJsonOutputChunk[]
): Promise<ICoverageAnalysisResult> {
  return analyzeCoverage(
    sourceText,
    chunks.map((ch) => ({
      text: ch.text,
      images: ch.images.map((im) => im.img),
    }))
  );
}
