import { splitIntoParts } from "@/lib/split";
import mammoth from "mammoth";

type LLMBackend = "ollama" | "vllm";

const LLM_BACKEND: LLMBackend =
  process.env.LLM_BACKEND?.toLowerCase() === "vllm" ? "vllm" : "ollama";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

const VLLM_URL = process.env.VLLM_URL ?? "";
const VLLM_MODEL = process.env.VLLM_MODEL ?? "";
const VLLM_MAX_TOKENS = Number(process.env.VLLM_MAX_TOKENS) || 4096;

/** Max tokens of document text per LLM request. Kept under 8k context so prompt + response fit. */
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

/** Thrown when the LLM response is invalid but the request may be retried (e.g. Ollama returned non-JSON). */
class RetryableChunkError extends ChunkError {
  constructor(message: string) {
    super(message, 500);
    this.name = "RetryableChunkError";
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

function getBackendLabel(): string {
  return LLM_BACKEND === "vllm" ? "vLLM" : "Ollama";
}

function getBackendUrl(): string {
  return LLM_BACKEND === "vllm" ? VLLM_URL : OLLAMA_URL;
}

/** Fetches raw text response from configured LLM (Ollama or vLLM). */
async function getRawResponseFromLLM(
  part: string,
  systemInstruction: string,
  phase: "chunk" | "merge"
): Promise<string> {
  if (LLM_BACKEND === "vllm") {
    const url = VLLM_URL.trim();
    if (!url) {
      throw new ChunkError(
        "LLM_BACKEND=vllm but VLLM_URL is not set. Set VLLM_URL (and optionally VLLM_MODEL) in .env",
        500
      );
    }
    const model = VLLM_MODEL.trim() || "default";
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: part },
        ],
        max_tokens: VLLM_MAX_TOKENS,
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ChunkError(
        `vLLM returned ${res.status} at ${phase} stage: ${body}`,
        500
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw =
      data.choices?.[0]?.message?.content ?? "";
    return raw.trim();
  }

  // Ollama
  const prompt = `${systemInstruction}\n\n---\n\n${part}`;
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ChunkError(
      `Ollama returned ${res.status} at ${phase} stage: ${body}`,
      500
    );
  }
  let data: { response?: string };
  try {
    data = (await res.json()) as { response?: string };
  } catch {
    throw new RetryableChunkError(
      `Invalid top-level JSON from Ollama at ${phase} stage`
    );
  }
  return (data.response ?? "").trim();
}

async function callLLMForChunks(
  part: string,
  systemInstruction: string,
  phase: "chunk" | "merge" = "chunk"
): Promise<string[]> {
  const backendLabel = getBackendLabel();
  const backendUrl = getBackendUrl();

  for (let attempt = 1; attempt <= MAX_INVALID_JSON_RETRIES; attempt++) {
    let raw: string;
    try {
      raw = await getRawResponseFromLLM(part, systemInstruction, phase);
    } catch (err) {
      if (err instanceof RetryableChunkError && attempt < MAX_INVALID_JSON_RETRIES) {
        console.warn(
          "[chunkService]",
          err.message,
          "- attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES,
          "- retrying…"
        );
        continue;
      }
      if (err instanceof ChunkError) throw err;
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new ChunkError(
        `${backendLabel} request failed at ${phase} stage: ${message}. Is the server running on ${backendUrl}?`,
        500
      );
    }

    let chunksFromPart: string[];
    try {
      chunksFromPart = parseChunksResponse(raw);
    } catch {
      console.error(
        "[chunkService] Failed to parse",
        backendLabel,
        "response at",
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
          "[chunkService] Retrying due to invalid 'chunks' JSON at",
          phase,
          "stage, attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES
        );
        continue;
      }

      throw new ChunkError(
        `${backendLabel} did not return valid JSON with a 'chunks' array at ${phase} stage`,
        500
      );
    }

    return postProcessChunks(chunksFromPart);
  }

  throw new ChunkError(
    `Unexpected error while calling ${backendLabel} at ${phase} stage`,
    500
  );
}

function parseChunksResponse(raw: string): string[] {
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

async function mergeChunksWithLLM(runs: string[][]): Promise<string[]> {
  if (!Array.isArray(runs) || runs.length === 0) {
    return [];
  }

  const content = JSON.stringify({ runs });
  return callLLMForChunks(content, SYSTEM_INSTRUCTION_MERGE, "merge");
}

export interface ChunkDocumentResult {
  partsWithChunks: { part: string; chunks: string[] }[];
}

/**
 * Извлекает текст из файла, разбивает на части, для каждой части запрашивает чанки у LLM (Ollama или vLLM по LLM_BACKEND),
 * постобрабатывает и возвращает результат. Выбрасывает ChunkError при ошибках валидации или LLM.
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
      const chunks = await callLLMForChunks(part, SYSTEM_INSTRUCTION, "chunk");
      runs.push(chunks);
    }

    const mergedChunks = await mergeChunksWithLLM(runs);
    partsWithChunks.push({ part, chunks: mergedChunks });
  }

  return { partsWithChunks };
}
