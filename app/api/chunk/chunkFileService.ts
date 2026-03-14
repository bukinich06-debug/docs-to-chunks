import mammoth from "mammoth";
import WordExtractor from "word-extractor";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_MIME = "application/msword";

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

export function isDocFile(file: File): boolean {
  return (
    file.type === DOC_MIME ||
    file.name.toLowerCase().endsWith(".doc")
  );
}

export async function extractTextFromFile(file: File): Promise<string> {
  if (isDocxFile(file)) {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (isDocFile(file)) {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody() ?? "";
  }
  return file.text();
}
