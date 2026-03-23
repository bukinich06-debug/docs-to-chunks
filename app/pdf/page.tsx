"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";

type PdfjsModule = typeof import("pdfjs-dist");
type PdfDocumentLoadingTask = ReturnType<PdfjsModule["getDocument"]>;
type PdfDocumentProxy = Awaited<PdfDocumentLoadingTask["promise"]>;

type PdfRef = {
  num: number;
  gen: number;
};

type PdfDestination = Array<unknown>;

type PdfOutlineItem = {
  title?: string;
  dest?: string | PdfDestination | null;
  items?: PdfOutlineItem[] | null;
};

type ParentItem = {
  id: string;
  label: string;
  title: string;
};

type FlatOutlineNode = {
  title: string;
  pageStart: number;
  top: number | null;
  parents: ParentItem[];
};

type OutputItem = {
  id: string;
  label: string;
  title: string;
  text: string;
  parents: ParentItem[];
};

const PDFJS_SRC = "/pdf.mjs";
const WORKER_SRC = "/pdf.worker.mjs";

let isWorkerConfigured = false;

function sanitizeTitle(title: string | undefined): string {
  const value = title?.trim();
  return value ? value : "Без названия";
}

function toParentItem(title: string): ParentItem {
  const match = title.match(/^(\d+(?:\.\d+)*\.?)\s+(.*)$/u);

  if (!match) {
    return {
      id: title,
      label: title,
      title,
    };
  }

  return {
    id: match[1],
    label: match[2].trim(),
    title,
  };
}

function stripPageNumberArtifacts(text: string): string {
  return text
    .replace(/^\d{1,3}\s+(?=(?:\d+(?:\.\d+)*\.?|[A-ZА-ЯЁ«"“„(]))/u, "")
    .replace(/\s+\d{1,3}$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeHyphenatedWords(text: string): string {
  return text.replace(/([A-Za-zА-Яа-яЁё])-\s+([A-Za-zА-Яа-яЁё])/g, "$1$2");
}

function isPdfTextItem(
  value: unknown
): value is { str: string; transform: number[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    "transform" in value &&
    typeof value.str === "string" &&
    Array.isArray(value.transform)
  );
}

function isPdfRef(value: unknown): value is PdfRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "num" in value &&
    "gen" in value &&
    typeof value.num === "number" &&
    typeof value.gen === "number"
  );
}

async function getPdfjs(): Promise<PdfjsModule> {
  const pdfjs = (await import(
    /* webpackIgnore: true */
    PDFJS_SRC
  )) as PdfjsModule;

  if (!isWorkerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;
    isWorkerConfigured = true;
  }

  return pdfjs;
}

async function resolveDestination(
  pdf: PdfDocumentProxy,
  item: PdfOutlineItem
): Promise<PdfDestination | null> {
  if (!item.dest) {
    return null;
  }

  if (typeof item.dest === "string") {
    const destination = await pdf.getDestination(item.dest);
    return Array.isArray(destination) ? destination : null;
  }

  return Array.isArray(item.dest) ? item.dest : null;
}

async function resolvePageNumber(
  pdf: PdfDocumentProxy,
  item: PdfOutlineItem
): Promise<number | null> {
  const destination = await resolveDestination(pdf, item);
  if (!destination?.length) {
    return null;
  }

  const pageRef = destination[0];

  if (isPdfRef(pageRef)) {
    const pageIndex = await pdf.getPageIndex(pageRef);
    return pageIndex + 1;
  }

  if (typeof pageRef === "number" && Number.isFinite(pageRef)) {
    return Math.trunc(pageRef) + 1;
  }

  return null;
}

async function resolveOutlineTop(
  pdf: PdfDocumentProxy,
  item: PdfOutlineItem,
  pageNumber: number
): Promise<number | null> {
  const destination = await resolveDestination(pdf, item);
  if (!destination?.length) {
    return null;
  }

  const page = await pdf.getPage(pageNumber);
  const pageHeight = page.getViewport({ scale: 1 }).height;
  const destinationType =
    typeof destination[1] === "object" &&
    destination[1] !== null &&
    "name" in destination[1] &&
    typeof destination[1].name === "string"
      ? destination[1].name
      : null;

  if (!destinationType) {
    return pageHeight;
  }

  if (destinationType === "XYZ") {
    return typeof destination[3] === "number" ? destination[3] : pageHeight;
  }

  if (destinationType === "FitH" || destinationType === "FitBH") {
    return typeof destination[2] === "number" ? destination[2] : pageHeight;
  }

  if (destinationType === "FitR") {
    return typeof destination[5] === "number" ? destination[5] : pageHeight;
  }

  return pageHeight;
}

function countOutlineSubtree(items: PdfOutlineItem[] | null | undefined): number {
  if (!items?.length) {
    return 0;
  }

  return items.reduce((total, item) => total + 1 + countOutlineSubtree(item.items), 0);
}

async function flattenOutlineItems(
  pdf: PdfDocumentProxy,
  items: PdfOutlineItem[],
  parentChain: ParentItem[] = []
): Promise<{ nodes: FlatOutlineNode[]; skippedCount: number }> {
  const nodes: FlatOutlineNode[] = [];
  let skippedCount = 0;

  for (const item of items) {
    const pageStart = await resolvePageNumber(pdf, item);

    if (!pageStart) {
      skippedCount += countOutlineSubtree([item]);
      continue;
    }

    const top = await resolveOutlineTop(pdf, item, pageStart);
    const title = sanitizeTitle(item.title);
    const currentParentItem = toParentItem(title);

    nodes.push({
      title,
      pageStart,
      top,
      parents: parentChain,
    });

    const childResult = await flattenOutlineItems(pdf, item.items ?? [], [
      ...parentChain,
      currentParentItem,
    ]);
    skippedCount += childResult.skippedCount;
    nodes.push(...childResult.nodes);
  }

  return { nodes, skippedCount };
}

async function extractPageText(
  pdf: PdfDocumentProxy,
  pageNumber: number,
  options?: {
    topBoundary?: number | null;
    bottomBoundary?: number | null;
  }
): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const topBoundary = options?.topBoundary;
  const bottomBoundary = options?.bottomBoundary;
  const boundaryTolerance = 4;

  const fragments = textContent.items.flatMap((item) => {
    if (isPdfTextItem(item)) {
      const itemY = item.transform[5];

      if (
        typeof topBoundary === "number" &&
        Number.isFinite(topBoundary) &&
        itemY > topBoundary + boundaryTolerance
      ) {
        return [];
      }

      if (
        typeof bottomBoundary === "number" &&
        Number.isFinite(bottomBoundary) &&
        itemY <= bottomBoundary + boundaryTolerance
      ) {
        return [];
      }

      const text = item.str.trim();
      return text ? [text] : [];
    }

    return [];
  });

  return mergeHyphenatedWords(stripPageNumberArtifacts(fragments.join(" ")));
}

async function materializeOutputItems(
  pdf: PdfDocumentProxy,
  nodes: FlatOutlineNode[],
  totalPages: number
): Promise<OutputItem[]> {
  const output: OutputItem[] = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const nextNode = nodes[index + 1];
    const pageEnd = nextNode ? nextNode.pageStart : totalPages;
    const pageTexts: string[] = [];
    const currentItem = toParentItem(node.title);

    for (let pageNumber = node.pageStart; pageNumber <= pageEnd; pageNumber += 1) {
      const pageText = await extractPageText(pdf, pageNumber, {
        topBoundary: pageNumber === node.pageStart ? node.top : null,
        bottomBoundary: nextNode && pageNumber === nextNode.pageStart ? nextNode.top : null,
      });

      if (pageText) {
        pageTexts.push(pageText);
      }
    }

    output.push({
      id: currentItem.id,
      label: currentItem.label,
      title: node.title,
      text: pageTexts.join("\n\n").trim(),
      parents: node.parents,
    });
  }

  return output;
}

function downloadJson(fileName: string, data: OutputItem[]): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  anchor.click();

  URL.revokeObjectURL(url);
}

function getBaseName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "") || "document";
}

export default function PdfPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OutputItem[] | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    setError(null);
    setResult(null);
    setSkippedCount(0);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!file) {
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setSkippedCount(0);

    let loadingTask: PdfDocumentLoadingTask | null = null;
    let pdf: PdfDocumentProxy | null = null;

    try {
      const pdfjs = await getPdfjs();
      const buffer = await file.arrayBuffer();
      loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
      pdf = await loadingTask.promise;

      const outline = (await pdf.getOutline()) as PdfOutlineItem[] | null;

      if (!outline?.length) {
        throw new Error("В этом PDF не найден outline/bookmarks.");
      }

      const flatOutline = await flattenOutlineItems(pdf, outline);

      if (!flatOutline.nodes.length) {
        throw new Error("Не удалось разрешить ни один bookmark: все destinations оказались невалидными.");
      }

      const output = await materializeOutputItems(pdf, flatOutline.nodes, pdf.numPages);

      setResult(output);
      setSkippedCount(flatOutline.skippedCount);
      downloadJson(`${getBaseName(file.name)}-outline.json`, output);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось обработать PDF.");
    } finally {
      if (pdf) {
        await pdf.destroy();
      }

      loadingTask?.destroy();
      setLoading(false);
    }
  };

  const previewJson = result ? JSON.stringify(result, null, 2) : null;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          PDF Outline JSON
        </h1>
        <p className="mb-6 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Загрузите PDF с bookmarks/outlines. После нажатия на кнопку страница соберёт
          плоский JSON-массив разделов и текст каждого раздела до следующего bookmark.
        </p>

        <form onSubmit={handleSubmit} className="mb-6 space-y-4">
          <div>
            <label htmlFor="pdf-file" className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              PDF файл
            </label>
            <input
              id="pdf-file"
              type="file"
              accept=".pdf,application/pdf"
              onChange={handleFileChange}
              disabled={loading}
              className="block w-full max-w-md rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            />
            {file && (
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                Выбран файл: {file.name}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={!file || loading}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "Обработка..." : "Обработать и скачать JSON"}
          </button>
        </form>

        {error && (
          <p className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
            {error}
          </p>
        )}

        {result && previewJson && (
          <section className="space-y-4">
            <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
              <p className="text-sm text-zinc-700 dark:text-zinc-300">
                JSON сформирован. Всего разделов: {result.length}.
              </p>
              {skippedCount > 0 && (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
                  Пропущено bookmark-узлов из-за невалидных destinations: {skippedCount}.
                </p>
              )}
            </div>

            <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950 dark:border-zinc-700">
              <pre className="max-h-[70vh] overflow-auto p-4 text-xs text-zinc-100">
                {previewJson}
              </pre>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
