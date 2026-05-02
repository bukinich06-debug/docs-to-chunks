import type { OutlineSectionImage } from "@/lib/outlineOutput";
import { ChunkError } from "../chunkService";
import { chunkParts } from "./chunkPartsService";
import { IJsonChunkInputItem, IJsonChunkOutputItem, IJsonChunkParent } from "./types";

function isJsonChunksFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return true;
  const t = file.type.toLowerCase();
  return t === "application/json" || t === "text/json";
}

function getRequiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChunkError(`${path} должно быть непустой строкой.`, 400);
  }
  return value;
}

function parseParent(parent: unknown, index: number, itemIndex: number): IJsonChunkParent {
  if (parent === null || typeof parent !== "object") {
    throw new ChunkError(`Элемент parents[${index}] у записи [${itemIndex}] должен быть объектом.`, 400);
  }

  return {
    number: getRequiredString(
      (parent as Record<string, unknown>).number,
      `Поле number в parents[${index}] у записи [${itemIndex}]`
    ),
    label: getRequiredString(
      (parent as Record<string, unknown>).label,
      `Поле label в parents[${index}] у записи [${itemIndex}]`
    ),
    title: getRequiredString(
      (parent as Record<string, unknown>).title,
      `Поле title в parents[${index}] у записи [${itemIndex}]`
    ),
  };
}

function parseSectionImage(
  img: unknown,
  itemIndex: number,
  imageIndex: number
): OutlineSectionImage {
  if (img === null || typeof img !== "object") {
    throw new ChunkError(
      `Элемент images[${imageIndex}] у записи [${itemIndex}] должен быть объектом.`,
      400
    );
  }

  const r = img as Record<string, unknown>;
  const type = r.type;
  if (type !== "icon" && type !== "pict") {
    throw new ChunkError(
      `Поле type у images[${imageIndex}] записи [${itemIndex}] должно быть "icon" или "pict".`,
      400
    );
  }

  return {
    name: getRequiredString(r.name, `Поле name у images[${imageIndex}] записи [${itemIndex}]`),
    img: getRequiredString(r.img, `Поле img у images[${imageIndex}] записи [${itemIndex}]`),
    llmname: getRequiredString(
      r.llmname,
      `Поле llmname у images[${imageIndex}] записи [${itemIndex}]`
    ),
    description: getRequiredString(
      r.description,
      `Поле description у images[${imageIndex}] записи [${itemIndex}]`
    ),
    type,
  };
}

function parseOptionalImages(
  record: Record<string, unknown>,
  itemIndex: number
): OutlineSectionImage[] | undefined {
  if (record.images === undefined) {
    return undefined;
  }
  if (!Array.isArray(record.images)) {
    throw new ChunkError(`Поле images у элемента [${itemIndex}] должно быть массивом.`, 400);
  }
  return record.images.map((img, j) => parseSectionImage(img, itemIndex, j));
}

const getPartInfo = (parsed: unknown): IJsonChunkInputItem[] => {
  if (!Array.isArray(parsed)) {
    throw new ChunkError("JSON должен быть массивом объектов с полями number, label, title, text, parents.", 400);
  }

  const parts: IJsonChunkInputItem[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (item === null || typeof item !== "object") {
      throw new ChunkError(`Элемент [${i}] должен быть объектом с полем text.`, 400);
    }

    const record = item as Record<string, unknown>;
    const parents = record.parents;
    if (!Array.isArray(parents)) {
      throw new ChunkError(`Поле parents у элемента [${i}] должно быть массивом.`, 400);
    }

    const input: IJsonChunkInputItem = {
      number: getRequiredString(record.number, `Поле number у элемента [${i}]`),
      label: getRequiredString(record.label, `Поле label у элемента [${i}]`),
      title: getRequiredString(record.title, `Поле title у элемента [${i}]`),
      text: getRequiredString(record.text, `Поле text у элемента [${i}]`),
      parents: parents.map((parent, parentIndex) => parseParent(parent, parentIndex, i)),
    };

    const images = parseOptionalImages(record, i);
    if (images !== undefined) {
      input.images = images;
    }

    parts.push(input);
  }

  return parts;
};

/**
 * Читает JSON-файл с массивом объектов и для каждого text запускает пайплайн чанкинга.
 */
export async function chunkFromChunksJsonFile(file: File): Promise<IJsonChunkOutputItem[]> {
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

  const parts = getPartInfo(parsed);
  
  return chunkParts(parts);
}
