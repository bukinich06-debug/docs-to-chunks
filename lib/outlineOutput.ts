export type ParentItem = {
  number: string;
  label: string;
  title: string;
};

export type ImageLlmType = "icon" | "pict";

export type OutlineSectionImage = {
  name: string;
  img: string;
  llmname: string;
  description: string;
  type: ImageLlmType;
};

export type OutputItem = {
  number: string;
  label: string;
  title: string;
  text: string;
  parents: ParentItem[];
  images?: OutlineSectionImage[];
};

export function sanitizeTitle(title: string | undefined): string {
  const value = title?.trim();
  return value ? value : "Без названия";
}

export function toParentItem(title: string): ParentItem {
  const match = title.match(/^(\d+(?:\.\d+)*\.?)\s+(.*)$/u);

  if (!match) {
    return {
      number: title,
      label: title,
      title,
    };
  }

  return {
    number: match[1],
    label: match[2].trim(),
    title,
  };
}

export function downloadOutlineJson(fileName: string, data: OutputItem[]): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  downloadBlob(fileName, blob);
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  anchor.click();

  URL.revokeObjectURL(url);
}

export function outlineJsonBaseName(fileName: string, extension: string): string {
  const re = new RegExp(`\\.${extension}$`, "i");
  return fileName.replace(re, "") || "document";
}
