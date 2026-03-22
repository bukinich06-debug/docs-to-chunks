import { ChunkError, type IChunkDocumentResult } from "../chunkService";
import { chunkParts } from "./chunkPartsService";

function isJsonChunksFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return true;
  const t = file.type.toLowerCase();
  return t === "application/json" || t === "text/json";
}

function partsFromChunksJsonPayload(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== "object") {
    throw new ChunkError("JSON должен быть объектом с полем chunks (массив).", 400);
  }

  const chunks = (parsed as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) {
    throw new ChunkError("В JSON отсутствует массив chunks или он не массив.", 400);
  }

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const item = chunks[i];
    if (item === null || typeof item !== "object") {
      throw new ChunkError(`Элемент chunks[${i}] должен быть объектом с полем text.`, 400);
    }

    const text = (item as { text?: unknown }).text;
    if (text === undefined) {
      throw new ChunkError(`У элемента chunks[${i}] нет поля text.`, 400);
    }

    if (typeof text !== "string") {
      throw new ChunkError(`Поле text в chunks[${i}] должно быть строкой.`, 400);
    }

    const trimmed = text.trim();
    if (trimmed) parts.push(trimmed);
  }

  return parts;
}

/**
 * Читает файл *.chunks.json (объект с metadata и chunks[].text), для каждого непустого text — тот же пайплайн, что и для частей документа.
 */
export async function chunkFromChunksJsonFile(file: File): Promise<IChunkDocumentResult> {
  if (!isJsonChunksFile(file)) {
    throw new ChunkError("Файл должен быть JSON (.json или application/json).", 400);
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch {
    throw new ChunkError("Не удалось прочитать файл.", 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ChunkError("Невалидный JSON.", 400);
  }

  const parts = partsFromChunksJsonPayload(parsed);
  if (parts.length === 0) throw new ChunkError("Нет текста для обработки: все поля text пустые.", 400);
  
  return chunkParts(parts);
}
