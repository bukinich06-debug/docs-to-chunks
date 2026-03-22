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

Правила:
1. Каждый чанк — ответ на ОДИН возможный вопрос пользователя.
2. Чанк должен содержать достаточно контекста для ответа: не просто заголовок или название поля ("Текущая дата"), а законченную мысль или краткую инструкцию (например: "При регистрации автоматически подставляется текущая дата").
3. Целевой размер чанка: для определений и сокращений — 1–3 предложения (~30–80 слов); для процедур и инструкций — 2–6 предложений (~50–150 слов). Чанк должен быть самодостаточным ответом, но не превращаться в целую главу.
4. Делай такое количество чанков чтобы получить всю полезную информацию из предоставленной инструкции, но не один огромный блок и не отдельные слова/метки.
5. КОНТЕКСТ РАЗДЕЛА: если во фрагменте есть заголовки, разделы, вкладки, страницы, главы — в начале чанка кратко укажи, к чему он относится (например: "Раздел «Регистрация»: ..." или "Вкладка «Настройки»: ..." или "«Учётные данные»: ..."). Это нужно, чтобы при поиске по базе чанков было понятно, о какой части инструкции идёт речь, и не путать одинаковые названия из разных разделов.
6. НЕ включай в чанки: описания картинок, подписи к рисункам ("Рисунок 1", "Рисунок 25"), упоминания изображений; а также подписи и ссылки на таблицы из инструкции ("Таблица 18", "Таблица 1" и т.п.). Это нумерация элементов документа — в базе чанков нет ни рисунков, ни таблиц, такие метки бессмысленны. Пропускай такие фрагменты и не начинай чанки с "Таблица N: ..." или "Рисунок N: ...".
7. НЕ включай содержания и описания не имеющие смысловой важности.
8. НЕ включай техническую информацию о предоставленной инструкции. Например дата создания инструкции, дата редактирования, кем отредактировано.
9. Ответь СТРОГО одним валидным JSON-объектом в формате: { "chunks": [ "текст первого чанка", "текст второго чанка", ... ] }. Без комментариев до или после JSON.
10. ВНУТРИ строк JSON все двойные кавычки (") ДОЛЖНЫ быть экранированы как \\". Пример: вместо текста Компания "Ромашка" в JSON-строке должно быть Компания \\"Ромашка\\" .`;

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
      throw new Error(`vLLM returned ${res.status} at ${phase} stage: ${body}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    return raw.trim();
  }

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
