import type { IPartInfo } from "./types";

/** Убирает ведущую нумерацию вида "2.5. ", "3.1.1. ", "10 " и т.п. */
const LEADING_NUMBERING = /^\d+(?:\.\d+)*\.?\s+/;

function stripLeadingNumbering(value: string): string {
    return value.replace(LEADING_NUMBERING, "").trim();
}

/**
 * Строит массив строк: перед каждой строкой из `lines` добавляется
 * `[глава] [подраздел]: `, где заголовки очищены от ведущих номеров.
 */
export const addChapterForChunks = (part: IPartInfo, chunks: string[]): string[] => {
    const chapter = stripLeadingNumbering(part.chapter);
    const subsectionRaw = part.subsection?.trim() ?? "";
    const subsection = subsectionRaw ? stripLeadingNumbering(subsectionRaw) : "";

    const prefix =
        subsection !== ""
            ? `[${chapter}] [${subsection}]: `
            : `[${chapter}]: `;

    return chunks.map((line) => `${prefix}${line}`);
};
