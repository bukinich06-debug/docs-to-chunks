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
3. Целевой размер чанка: для определений и сокращений — 1–3 предложения (~30–80 слов); для процедур и инструкций — 2–6 предложений (~50–150 слов). Чанк должен быть самодостаточным ответом, но не превращаться в целую главу.
4. Делай такое количество чанков чтобы получить всю полезную информацию из предоставленной инструкции, но не один огромный блок и не отдельные слова/метки.
5. НЕ включай в чанки: описания картинок, подписи к рисункам ("Рисунок 1"), упоминания изображений. Пропускай такие фрагменты.
6. НЕ включай содежания и описания не имеющие смысловой важности.
7. НЕ включай техническую информцию о предоставленной инструкции. Например дата создания инструкции, дата редактирования, кем редатировано.
8. Ответь СТРОГО одним валидным JSON-объектом в формате: { "chunks": [ "текст первого чанка", "текст второго чанка", ... ] }. Без комментариев до или после JSON.
9. ВНУТРИ строк JSON все двойные кавычки (") ДОЛЖНЫ быть экранированы как \\". Пример: вместо текста Компания "Ромашка" в JSON-строке должно быть Компания \\"Ромашка\\" .`;

const SYSTEM_INSTRUCTION_MERGE = `Ты помогаешь объединить несколько наборов чанков, полученных из одной и той же части инструкции.

На вход ты получаешь JSON-объект:
{ "runs": [ ["чанк1_run1", "чанк2_run1", ...], ["чанк1_run2", ...], ["чанк1_run3", ...] ] }

Задача — получить ИТОГОВЫЙ массив чанков, в котором каждый чанк:
- описывает УНИКАЛЬНЫЙ по смыслу фрагмент информации;
- не дублирует и не перефразирует уже существующий в результате чанк.

Правила:
1. Сначала по смыслу сгруппируй все входные чанки: какие из них говорят об одном и том же (даже если разными словами).
2. Для каждой такой смысловой группы создай один лучший чанк:
   - можешь переформулировать и объединить несколько исходных чанков в один;
   - убери повторы и лишние детали, оставь главное;
   - не копируй механически один и тот же текст из разных массивов.
3. Если два чанка очень похожи (одно и то же правило/процедура/ограничение), в итоговом массиве должен остаться ТОЛЬКО один чанк, описывающий этот смысл.
4. Если чанк содержит ровно ту же информацию, что и уже отобранный итоговый, но другими словами, — НЕ добавляй его, это считается дубликатом по смыслу.
5. Игнорируй откровенно бессмысленные, оборванные или слишком короткие фрагменты, которые не могут быть полезным ответом на вопрос пользователя.

Ответь СТРОГО одним валидным JSON-объектом в формате: { "chunks": [ "текст первого итогового чанка", "текст второго итогового чанка", ... ] }. Без комментариев до или после JSON.`;

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

/** Удаляет лишние символы в начале и конце текста (цитаты, знаки препинания из-за неудачных разделений). Не трогает парные кавычки « », чтобы не обрезать названия вроде «ТОР КНД». */
function normalizeChunk(text: string): string {
  return text
    .replace(/^[\s'\"\-–—.,:;]+/, "")
    .replace(/[\s'\"\-–—.,:;]+$/, "")
    .trim();
}

function postProcessChunks(chunks: string[]): string[] {
  return chunks
    .map(normalizeChunk)
    .filter((s) => s.length > 0);
}

const MAX_INVALID_JSON_RETRIES = 3;

async function callOllamaForChunks(
  part: string,
  systemInstruction: string,
  phase: "chunk" | "merge" = "chunk"
): Promise<string[]> {
  const prompt = `${systemInstruction}\n\n---\n\n${part}`;
  for (let attempt = 1; attempt <= MAX_INVALID_JSON_RETRIES; attempt++) {
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
        `Ollama request failed at ${phase} stage: ${message}. Is Ollama running on ${OLLAMA_URL}?`,
        500
      );
    }

    if (!res.ok) {
      const body = await res.text();
      throw new ChunkError(
        `Ollama returned ${res.status} at ${phase} stage: ${body}`,
        500
      );
    }

    let data: { response?: string };
    try {
      data = await res.json();
    } catch {
      if (attempt < MAX_INVALID_JSON_RETRIES) {
        console.warn(
          "[chunkService] Invalid top-level JSON from Ollama at",
          phase,
          "stage, attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES,
          "- retrying…"
        );
        continue;
      }
      throw new ChunkError(
        `Invalid JSON response from Ollama at ${phase} stage`,
        500
      );
    }

    const raw = (data.response ?? "").trim();
    let chunksFromPart: string[];
    try {
      chunksFromPart = parseOllamaChunksResponse(raw);
    } catch {
      // Логируем сырой ответ модели, чтобы упростить отладку промпта и формата JSON.
      // Особенно полезно на этапе merge, когда модель может вернуть неожиданный формат.
      console.error(
        "[chunkService] Failed to parse Ollama response at",
        phase,
        "stage. Raw response:",
        raw,
        "attempt",
        attempt,
        "of",
        MAX_INVALID_JSON_RETRIES
      );

      if (attempt < MAX_INVALID_JSON_RETRIES) {
        console.warn(
          "[chunkService] Retrying Ollama call due to invalid 'chunks' JSON at",
          phase,
          "stage, attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES
        );
        continue;
      }

      throw new ChunkError(
        `Ollama did not return valid JSON with a 'chunks' array at ${phase} stage`,
        500
      );
    }

    return postProcessChunks(chunksFromPart);
  }

  // Теоретически недостижимо, все ветки выше либо возвращают результат, либо кидают ошибку.
  throw new ChunkError(
    `Unexpected error while calling Ollama at ${phase} stage`,
    500
  );
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

async function mergeChunksWithOllama(runs: string[][]): Promise<string[]> {
  if (!Array.isArray(runs) || runs.length === 0) {
    return [];
  }

  const content = JSON.stringify({ runs });
  return callOllamaForChunks(content, SYSTEM_INSTRUCTION_MERGE, "merge");
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

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const runs: string[][] = [];

    for (let run = 0; run < 3; run++) {
      const chunks = await callOllamaForChunks(part, SYSTEM_INSTRUCTION, "chunk");
      runs.push(chunks);
    }

    const mergedChunks = await mergeChunksWithOllama(runs);
    partsWithChunks.push({ part, chunks: mergedChunks });
  }

  return { partsWithChunks };
}
