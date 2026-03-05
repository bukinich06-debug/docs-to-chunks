import { splitIntoParts } from "@/lib/split";
import mammoth from "mammoth";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

/** Max tokens of document text per Ollama request. Kept under 8k context so prompt + response fit. */
const MAX_TOKENS_PER_REQUEST = 1000;

const SYSTEM_INSTRUCTION = `Ты разбиваешь текст инструкции/документации на чанки для поиска по вопросам пользователей.

Правила:
1. Каждый чанк — ответ на ОДИН возможный вопрос пользователя.
2. Чанк должен содержать достаточно контекста для ответа: не просто заголовок или название поля ("Текущая дата"), а законченную мысль или краткую инструкцию (например: "При регистрации автоматически подставляется текущая дата").
3. Делай такое количество чанков чтобы получить всю полезную информацию из предоставленной инструкции, но не один огромный блок и не отдельные слова/метки.
4. НЕ включай в чанки: описания картинок, подписи к рисункам ("Рисунок 1"), упоминания изображений. Пропускай такие фрагменты.
5. НЕ включай содежания и описания не имеющие смысловой важности.
5. НЕ включай техническую информцию о предоставленной инструкции. Например дата создания инструкции, дата редактирования, кем редатировано.
6. Ответь СТРОГО одним валидным JSON-объектом в формате: { "chunks": [ "текст первого чанка", "текст второго чанка", ... ] }. Без комментариев до или после JSON.`;

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

export function isTextFile(file: File): boolean {
  return (
    file.type === "text/plain" ||
    file.name.endsWith(".txt") ||
    file.type.startsWith("text/")
  );
}

export function isDocxFile(file: File): boolean {
  return (
    file.type === DOCX_MIME ||
    file.name.toLowerCase().endsWith(".docx")
  );
}

export async function extractTextFromFile(file: File): Promise<string> {
  if (isDocxFile(file)) {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return file.text();
}

/** Удаляет лишние символы в начале и конце текста (цитаты, знаки препинания из-за неудачных разделений). */
function normalizeChunk(text: string): string {
  return text
    .replace(/^[\s'\"«»\-–—.,:;]+/, "")
    .replace(/[\s'\"«»\-–—.,:;]+$/, "")
    .trim();
}

function postProcessChunks(chunks: string[]): string[] {
  return chunks
    .map(normalizeChunk)
    .filter((s) => s.length > 0);
}

function parseOllamaChunksResponse(raw: string): string[] {
  let jsonStr = raw;
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/;
  const m = raw.match(codeBlock);
  if (m) jsonStr = m[1].trim();
  const parsed = JSON.parse(jsonStr) as { chunks?: unknown };
  const arr = Array.isArray(parsed.chunks) ? parsed.chunks : [];
  return arr
    .map((c) => (typeof c === "string" ? c : String(c)).trim())
    .filter(Boolean);
}

export interface ChunkDocumentResult {
  partsWithChunks: { part: string; chunks: string[] }[];
}

/**
 * Извлекает текст из файла, разбивает на части, для каждой части запрашивает чанки у Ollama,
 * постобрабатывает и возвращает результат. Выбрасывает ChunkError при ошибках валидации или Ollama.
 */
export async function chunkDocument(file: File): Promise<ChunkDocumentResult> {
  if (!isTextFile(file) && !isDocxFile(file)) {
    throw new ChunkError("File must be .txt or .docx", 400);
  }

  let text: string;
  try {
    text = await extractTextFromFile(file);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to read file";
    throw new ChunkError(msg, 400);
  }

  const trimmed = text.trim();
  if (!trimmed) {
    throw new ChunkError("File is empty", 400);
  }

  const parts = splitIntoParts(trimmed, MAX_TOKENS_PER_REQUEST);
  const partsWithChunks: { part: string; chunks: string[] }[] = [];

  // for (let i = 0; i < parts.length; i++) {
    const part = parts[0];
    const prompt = `${SYSTEM_INSTRUCTION}\n\n---\n\n${part}`;

    let res: Response;
    try {
      res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt,
          stream: false,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new ChunkError(
        `Ollama request failed: ${message}. Is Ollama running on ${OLLAMA_URL}?`,
        500
      );
    }

    if (!res.ok) {
      const body = await res.text();
      throw new ChunkError(`Ollama returned ${res.status}: ${body}`, 500);
    }

    let data: { response?: string };
    try {
      data = await res.json();
    } catch {
      throw new ChunkError("Invalid JSON response from Ollama", 500);
    }

    const raw = (data.response ?? "").trim();
    let chunksFromPart: string[];
    try {
      chunksFromPart = parseOllamaChunksResponse(raw);
    } catch {
      throw new ChunkError(
        "Ollama did not return valid JSON with a 'chunks' array",
        500
      );
    }

    const filtered = postProcessChunks(chunksFromPart);
    partsWithChunks.push({ part, chunks: filtered });
  // }

  return { partsWithChunks };
}
