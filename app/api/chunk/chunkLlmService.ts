type LLMBackend = "ollama" | "vllm";

const LLM_BACKEND: LLMBackend =
  process.env.LLM_BACKEND?.toLowerCase() === "vllm" ? "vllm" : "ollama";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

const VLLM_URL = process.env.VLLM_URL ?? "";
const VLLM_MODEL = process.env.VLLM_MODEL ?? "";
const VLLM_MAX_TOKENS = Number(process.env.VLLM_MAX_TOKENS) || 4096;

const MAX_INVALID_JSON_RETRIES = 3;
const SYSTEM_INSTRUCTION = `Ты разбиваешь текст инструкции/документации на чанки для поиска по вопросам пользователей.

КРАЙНЕ ВАЖНО!: Обработай весь предоставленный фрагмент от начала до конца, без пропусков.
КРАЙНЕ ВАЖНО!: Количество чанков должно соответствовать объёму текста: больше текст — больше чанков.

СТРОГО ПО ИСХОДНОМУ ТЕКСТУ (без додумывания):
- Каждый чанк отражает только то, что есть во входном фрагменте; не добавляй факты, цифры, названия, шаги, которых нет в тексте.
- Не опирайся на общие знания о продукте или предметной области; если в тексте не сказано явно — не дополняй.
- Допустима сжатая перефразировка и объединение предложений из текста, но без новых утверждений.
- Если для самодостаточности не хватает контекста во фрагменте — сформулируй только то, что явно следует из текста, не выдумывая недостающий контекст.

Правила:
1. Каждый чанк — ответ на ОДИН возможный вопрос пользователя.
2. Чанк должен содержать достаточно контекста для ответа: не просто заголовок или название поля ("Текущая дата"), а законченную мысль или краткую инструкцию (например: "При регистрации автоматически подставляется текущая дата").
3. Целевой размер чанка: для определений и сокращений — 1–3 предложения (~30–80 слов); для процедур и инструкций — 2–6 предложений (~50–150 слов). Чанк должен быть самодостаточным ответом, но не превращаться в целую главу.
4. Делай такое количество чанков чтобы получить всю полезную информацию из предоставленной инструкции, но не один огромный блок и не отдельные слова/метки.
5. НЕ включай в чанки: описания картинок, подписи к рисункам ("Рисунок 1", "Рисунок 25"), упоминания изображений; а также подписи и ссылки на таблицы из инструкции ("Таблица 18", "Таблица 1" и т.п.). Это нумерация элементов документа — в базе чанков нет ни рисунков, ни таблиц, такие метки бессмысленны. Пропускай такие фрагменты и не начинай чанки с "Таблица N: ..." или "Рисунок N: ...".
6. НЕ включай содержания и описания не имеющие смысловой важности.
7. НЕ включай техническую информацию о предоставленной инструкции. Например дата создания инструкции, дата редактирования, кем отредактировано.
8. Ответь СТРОГО одним валидным JSON-объектом в формате: { "chunks": [ "текст первого чанка", "текст второго чанка", ... ] }. Без комментариев до или после JSON.
9. ВНУТРИ строк JSON все двойные кавычки (") ДОЛЖНЫ быть экранированы как \\". Пример: вместо текста Компания "Ромашка" в JSON-строке должно быть Компания \\"Ромашка\\" .`;

/** Одна строка ответа LLM для JSON-пайплайна (пути изображений до обогащения метаданными). */
export type LlmJsonChunkRow = {
  text: string;
  images: string[];
};

function buildJsonChunksInstruction(availableImagePaths: string[]): string {
  const pathsBlock =
    availableImagePaths.length === 0
      ? `В этом фрагменте каталог изображений пуст: в поле "images" у каждого чанка всегда указывай [].

Во входном тексте могут отсутствовать разметочные теги изображений.`
      : `Каталог допустимых путей изображений для этого фрагмента (используй ТОЛЬКО эти строки в поле "images" чанков, без изменений и без выдуманных путей):
${availableImagePaths.map((p) => `- ${p}`).join("\n")}`;

  return `Ты разбиваешь текст инструкции/документации на чанки для поиска по вопросам пользователей.

КРАЙНЕ ВАЖНО!: Обработай весь предоставленный фрагмент от начала до конца, без пропусков.
КРАЙНЕ ВАЖНО!: Количество чанков должно соответствовать объёму текста: больше текст — больше чанков.

СТРОГО ПО ИСХОДНОМУ ТЕКСТУ (без додумывания):
- Каждый чанк отражает только то, что есть во входном фрагменте; не добавляй факты, цифры, названия, шаги, которых нет в тексте.
- Не опирайся на общие знания о продукте или предметной области; если в тексте не сказано явно — не дополняй.
- Допустима сжатая перефразировка и объединение предложений из текста, но без новых утверждений.
- Если для самодостаточности не хватает контекста во фрагменте — сформулируй только то, что явно следует из текста, не выдумывая недостающий контекст.

Разметка изображений во входном тексте:
- Могут встречаться блоки вида ⟦img path="ОТНОСИТЕЛЬНЫЙ_ПУТЬ"⟧ ...описание того, что на скриншоте... ⟦/img⟧ — это место, где в исходной документации был рисунок/скриншот; между открывающим и закрывающим тегом — текстовое описание изображения.
- Могут встречаться блоки вида ⟦icon path="ПУТЬ" name="..."⟧ ...описание иконки... ⟦/icon⟧ — место маленькой иконки в интерфейсе.
- Сами литералы тегов ⟦img⟧, ⟦/img⟧, ⟦icon⟧, ⟦/icon⟧ и атрибуты path/name НЕ должны попадать в поле "text" чанков. В "text" пиши только связный текст документации и при необходимости сжатое/перефразированное описание содержимого изображения изнутри тегов, если оно нужно для самодостаточного ответа на вопрос пользователя.
- НЕ включай в "text" подписи-нумерации вроде «Рис. 1-1», «Рисунок 25», а также ссылки на таблицы («Таблица 18» и т.п.) — это служебная нумерация документа.

${pathsBlock}

Правила:
1. Каждый чанк — ответ на ОДИН возможный вопрос пользователя.
2. Чанк должен содержать достаточно контекста для ответа: не просто заголовок или название поля ("Текущая дата"), а законченную мысль или краткую инструкцию.
3. Целевой размер чанка: для определений и сокращений — 1–3 предложения (~30–80 слов); для процедур и инструкций — 2–6 предложений (~50–150 слов). Чанк должен быть самодостаточным ответом, но не превращаться в целую главу.
4. Делай такое количество чанков чтобы получить всю полезную информацию из предоставленной инструкции, но не один огромный блок и не отдельные слова/метки.
5. НЕ включай содержания и описания не имеющие смысловой важности.
6. НЕ включай техническую информацию о предоставленной инструкции (даты создания/редактирования, авторы правок и т.п.).
7. Для каждого чанка укажи в поле "images" массив путей (строк) из каталога выше: перечисли все изображения/иконки из входного фрагмента, чьё содержимое логически относится к этому чанку (по смыслу и по исходному порядку в тексте). Если в чанке нет ни одного такого изображения — "images": [].
8. Ответь СТРОГО одним валидным JSON-объектом в формате: { "chunks": [ { "text": "...", "images": ["путь1", ...] }, ... ] }. Без комментариев до или после JSON.
9. ВНУТРИ строк JSON все двойные кавычки (") ДОЛЖНЫ быть экранированы как \\". Пример: вместо текста Компания "Ромашка" в JSON-строке должно быть Компания \\"Ромашка\\" .`;
}

class RetryableChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableChunkError";
  }
}

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

function normalizeImagePathsForChunk(
  paths: unknown[],
  allowed: Set<string>
): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (!t || !allowed.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function parseJsonChunksResponse(
  raw: string,
  allowed: Set<string>
): LlmJsonChunkRow[] {
  let jsonStr = raw;
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```\s*$/;
  const m = raw.match(codeBlock);
  if (m) jsonStr = m[1].trim();
  const parsed = JSON.parse(jsonStr) as { chunks?: unknown };
  const arr = Array.isArray(parsed.chunks) ? parsed.chunks : [];
  const out: LlmJsonChunkRow[] = [];

  for (const c of arr) {
    if (typeof c === "string") {
      const text = normalizeChunk(c);
      if (text.length > 0) {
        out.push({ text, images: [] });
      }
      continue;
    }

    if (c !== null && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const textRaw = o.text;
      if (typeof textRaw !== "string") continue;
      const text = normalizeChunk(textRaw);
      if (text.length === 0) continue;

      const imgs = o.images;
      const imagePaths = Array.isArray(imgs)
        ? normalizeImagePathsForChunk(imgs, allowed)
        : [];

      out.push({ text, images: imagePaths });
    }
  }

  return out;
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

function getBackendLabel(): string {
  return LLM_BACKEND === "vllm" ? "vLLM" : "Ollama";
}

function getBackendUrl(): string {
  return LLM_BACKEND === "vllm" ? VLLM_URL : OLLAMA_URL;
}

async function getRawResponseFromLLM(
  part: string,
  systemInstruction: string,
  phase: "chunk" | "merge"
): Promise<string> {
  if (LLM_BACKEND === "vllm") {
    const url = VLLM_URL.trim();
    
    if (!url) {
      throw new Error(
        "LLM_BACKEND=vllm but VLLM_URL is not set. Set VLLM_URL (and optionally VLLM_MODEL) in .env"
      );
    }

    const model = VLLM_MODEL.trim() || "default";
    const requestPayload = {
      model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: part },
      ],
      chat_template_kwargs: {
        enable_thinking: false
      },
      max_tokens: VLLM_MAX_TOKENS,
      temperature: 0,
      stream: false,
    };

    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`vLLM returned ${res.status} at ${phase} stage: ${body}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content ?? "";
    return raw.trim();
  }

  const prompt = `${systemInstruction}\n\n---\n\n${part}`;
  const ollamaPayload = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: { temperature: 0 },
  };

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaPayload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama returned ${res.status} at ${phase} stage: ${body}`);
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

export async function callLLMForChunks(part: string): Promise<string[]> {
  const backendLabel = getBackendLabel();
  const backendUrl = getBackendUrl();
  const phase = "chunk";

  for (let attempt = 1; attempt <= MAX_INVALID_JSON_RETRIES; attempt++) {
    let raw: string;
    try {
      raw = await getRawResponseFromLLM(part, SYSTEM_INSTRUCTION, phase);
    } catch (err) {
      if (
        err instanceof RetryableChunkError &&
        attempt < MAX_INVALID_JSON_RETRIES
      ) {
        console.warn(
          "[chunkLlmService]",
          err.message,
          "- attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES,
          "- retrying…"
        );
        continue;
      }

      const message = err instanceof Error ? err.message : "Unknown error";
      throw new Error(
        `${backendLabel} request failed at ${phase} stage: ${message}. Is the server running on ${backendUrl}?`
      );
    }

    let chunksFromPart: string[];
    try {
      chunksFromPart = parseChunksResponse(raw);
    } catch {
      console.error(
        "[chunkLlmService] Failed to parse",
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
          "[chunkLlmService] Retrying due to invalid 'chunks' JSON at",
          phase,
          "stage, attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES
        );
        continue;
      }

      throw new Error(
        `${backendLabel} did not return valid JSON with a 'chunks' array at ${phase} stage`
      );
    }

    return postProcessChunks(chunksFromPart);
  }

  throw new Error(
    `Unexpected error while calling ${backendLabel} at ${phase} stage`
  );
}

/**
 * Чанкинг для JSON outline: возвращает текст чанка и пути изображений из каталога фрагмента.
 */
export async function callLLMForJsonChunks(
  part: string,
  availableImagePaths: string[]
): Promise<LlmJsonChunkRow[]> {
  const backendLabel = getBackendLabel();
  const backendUrl = getBackendUrl();
  const phase = "chunk";
  const allowed = new Set(
    availableImagePaths.map((p) => p.trim()).filter(Boolean)
  );
  const systemInstruction = buildJsonChunksInstruction(
    Array.from(allowed)
  );

  for (let attempt = 1; attempt <= MAX_INVALID_JSON_RETRIES; attempt++) {
    let raw: string;
    try {
      raw = await getRawResponseFromLLM(part, systemInstruction, phase);
    } catch (err) {
      if (
        err instanceof RetryableChunkError &&
        attempt < MAX_INVALID_JSON_RETRIES
      ) {
        console.warn(
          "[chunkLlmService]",
          err.message,
          "- attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES,
          "- retrying…"
        );
        continue;
      }

      const message = err instanceof Error ? err.message : "Unknown error";
      throw new Error(
        `${backendLabel} request failed at ${phase} stage: ${message}. Is the server running on ${backendUrl}?`
      );
    }

    let rows: LlmJsonChunkRow[];
    try {
      rows = parseJsonChunksResponse(raw, allowed);
    } catch {
      console.error(
        "[chunkLlmService] Failed to parse",
        backendLabel,
        "JSON-chunks response at",
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
          "[chunkLlmService] Retrying due to invalid JSON chunks at",
          phase,
          "stage, attempt",
          attempt,
          "of",
          MAX_INVALID_JSON_RETRIES
        );
        continue;
      }

      throw new Error(
        `${backendLabel} did not return valid JSON with a 'chunks' array of objects at ${phase} stage`
      );
    }

    if (rows.length === 0) {
      console.error(
        "[chunkLlmService] Empty chunks after parse, raw:",
        raw,
        "attempt",
        attempt
      );
      if (attempt < MAX_INVALID_JSON_RETRIES) {
        console.warn(
          "[chunkLlmService] Retrying due to empty chunks at",
          phase,
          "stage"
        );
        continue;
      }
      throw new Error(
        `${backendLabel} returned no usable chunks at ${phase} stage`
      );
    }

    return rows;
  }

  throw new Error(
    `Unexpected error while calling ${backendLabel} at ${phase} stage`
  );
}
