import type { ImageLlmType } from "@/lib/outlineOutput";

const DEFAULT_LLM_CHAT_BASE_URL = "http://mskpcai:3336";

const IMAGE_DESCRIPTION_USER_PROMPT =
  "Тебе отправлено изображение. Верни один JSON-объект (только валидный JSON, без markdown-ограждений и без текста до или после) с полями: " +
  '"name" (строка), "description" (строка), "type" (строка). ' +
  "В description — подробное описание содержимого изображения. " +
  "В name — короткое название, отражающее суть изображения. " +
  'В type укажи ровно "icon", если это маленькая иконка для кнопок и т.п., иначе "pict" для картинки, иллюстрации или скриншота. ' +
  "Поля name и description заполняй на русском языке. Если это иконка, в name по возможности укажи, что это иконка.";

export type LlmImageMetadata = {
  llmname: string;
  description: string;
  type: ImageLlmType;
};

const EMPTY_LLM_METADATA: LlmImageMetadata = {
  llmname: "",
  description: "",
  type: "pict",
};

type ChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export function getLlmChatBaseUrl(): string {
  const fromEnv = process.env.LLM_CHAT_BASE_URL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_LLM_CHAT_BASE_URL;
}

function stripMarkdownCodeFence(raw: string): string {
  const t = raw.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```/i.exec(t);
  return m?.[1] != null ? m[1].trim() : t;
}

function parseAssistantJsonContent(raw: string): unknown {
  const inner = stripMarkdownCodeFence(raw);
  return JSON.parse(inner) as unknown;
}

function readStringField(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

function normalizeLlmImageType(raw: unknown): ImageLlmType {
  if (typeof raw !== "string") return "pict";

  const t = raw.trim().toLowerCase();
  if (t === "icon") return "icon";

  return "pict";
}

function readMetadataFromParsed(parsed: unknown): LlmImageMetadata {
  if (!parsed || typeof parsed !== "object") return { ...EMPTY_LLM_METADATA };
  const rec = parsed as Record<string, unknown>;

  return {
    llmname: readStringField(rec, "name"),
    description: readStringField(rec, "description"),
    type: normalizeLlmImageType(rec.type),
  };
}

/**
 * Запрос к LLM: name, description, type из JSON в ответе ассистента.
 * При ошибке сети/парсинга — пустые строки и type "pict".
 */
export async function fetchImageMetadataFromLlm(
  buffer: Buffer,
  contentType: string
): Promise<LlmImageMetadata> {
  try {
    const base = getLlmChatBaseUrl().replace(/\/$/, "");
    const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "QuantTrio/Qwen3.6-27B-AWQ",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: IMAGE_DESCRIPTION_USER_PROMPT,
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl,
                },
              },
            ],
          },
        ],
        chat_template_kwargs: {
          enable_thinking: false,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "[fetchImageMetadataFromLlm] HTTP",
          res.status,
          errBody.slice(0, 500)
        );
      }
      return { ...EMPTY_LLM_METADATA };
    }

    const data = (await res.json()) as ChatCompletionsResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[fetchImageMetadataFromLlm] empty assistant content");
      }
      return { ...EMPTY_LLM_METADATA };
    }

    let parsed: unknown;
    try {
      parsed = parseAssistantJsonContent(content);
    } catch {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "[fetchImageMetadataFromLlm] JSON parse failed:",
          content.slice(0, 400)
        );
      }
      return { ...EMPTY_LLM_METADATA };
    }

    return readMetadataFromParsed(parsed);
  } catch (e) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[fetchImageMetadataFromLlm]", e);
    }
    return { ...EMPTY_LLM_METADATA };
  }
}
