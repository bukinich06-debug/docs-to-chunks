"use client";

import type { ICoverageAnalysisResult } from "@/app/api/chunk/chunkAnalysisTypes";
import type { IPartWithChunks } from "@/app/api/chunk/chunkService";
import type { IJsonChunkOutputItem } from "@/app/api/chunk/json/types";
import { useState } from "react";

type TabId = "document" | "json";

function analysisKey(kind: TabId, index: number): string {
  return `${kind}:${index}`;
}

function reindexAnalysisKeys(
  prev: Record<string, ICoverageAnalysisResult>,
  kind: TabId,
  deletedIndex: number
): Record<string, ICoverageAnalysisResult> {
  const next: Record<string, ICoverageAnalysisResult> = {};
  for (const [key, value] of Object.entries(prev)) {
    const colon = key.indexOf(":");
    if (colon === -1) continue;
    const keyKind = key.slice(0, colon) as TabId;
    const idx = Number(key.slice(colon + 1));
    if (keyKind !== kind) {
      next[key] = value;
      continue;
    }
    if (idx === deletedIndex) continue;
    const newIdx = idx > deletedIndex ? idx - 1 : idx;
    next[analysisKey(kind, newIdx)] = value;
  }
  return next;
}

function coveragePercentClass(percent: number): string {
  if (percent >= 80) return "text-emerald-700 dark:text-emerald-400";
  if (percent >= 50) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

function CoverageAnalysisCard({ analysis }: { analysis: ICoverageAnalysisResult }) {
  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-900/60">
      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        Покрытие:{" "}
        <span className={coveragePercentClass(analysis.coveragePercent)}>
          {analysis.coveragePercent}%
        </span>
      </p>
      <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{analysis.summary}</p>
      {analysis.coveredTopics.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Покрыто ({analysis.coveredTopics.length})
          </summary>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            {analysis.coveredTopics.map((topic, i) => (
              <li key={i}>{topic}</li>
            ))}
          </ul>
        </details>
      )}
      {analysis.missingTopics.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium text-red-800 dark:text-red-300">
            Пропущено ({analysis.missingTopics.length})
          </summary>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            {analysis.missingTopics.map((topic, i) => (
              <li key={i}>{topic}</li>
            ))}
          </ul>
        </details>
      )}
      {analysis.intentionallyExcluded.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-400">
            Намеренно исключено ({analysis.intentionallyExcluded.length})
          </summary>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            {analysis.intentionallyExcluded.map((topic, i) => (
              <li key={i}>{topic}</li>
            ))}
          </ul>
        </details>
      )}
      {analysis.notes && (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{analysis.notes}</p>
      )}
    </div>
  );
}

type ResultState =
  | { kind: "document"; items: IPartWithChunks[] }
  | { kind: "json"; items: IJsonChunkOutputItem[] }
  | null;

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("document");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ResultState>(null);
  const [error, setError] = useState<string | null>(null);
  const [jsonSourceSections, setJsonSourceSections] = useState<unknown[] | null>(null);
  const [retryingSection, setRetryingSection] = useState<{ kind: TabId; index: number } | null>(null);
  const [analyzingSection, setAnalyzingSection] = useState<{ kind: TabId; index: number } | null>(null);
  const [analysisByKey, setAnalysisByKey] = useState<Record<string, ICoverageAnalysisResult>>({});

  const clearAnalysisFor = (kind: TabId, index: number) => {
    const key = analysisKey(kind, index);
    setAnalysisByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const resetResult = () => {
    setResult(null);
    setError(null);
    setJsonSourceSections(null);
    setRetryingSection(null);
    setAnalyzingSection(null);
    setAnalysisByKey({});
  };

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    resetResult();
  };

  const handleDocumentFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setDocumentFile(f ?? null);
    resetResult();
  };

  const handleJsonFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setJsonFile(f ?? null);
    resetResult();
  };

  const handleDocumentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!documentFile) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.set("file", documentFile);

      const res = await fetch("/api/chunk", {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      setResult({ kind: "document", items: data.partsWithChunks ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const handleJsonSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jsonFile) return;

    setError(null);
    setResult(null);
    setJsonSourceSections(null);

    let raw: string;
    try {
      raw = await jsonFile.text();
    } catch {
      setError("Не удалось прочитать файл.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      setError("Невалидный JSON.");
      return;
    }

    if (!Array.isArray(parsed)) {
      setError("JSON должен быть массивом объектов.");
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      formData.set("file", new File([raw], jsonFile.name, { type: "application/json" }));

      const res = await fetch("/api/chunk/json", {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      setJsonSourceSections(parsed);
      setResult({ kind: "json", items: Array.isArray(data) ? data : [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRetryJsonSection = async (blockIndex: number) => {
    if (result?.kind !== "json" || !jsonSourceSections) return;
    const section = jsonSourceSections[blockIndex];
    if (section === undefined) {
      setError("Нет исходных данных для этого раздела. Обработайте JSON заново.");
      return;
    }

    setRetryingSection({ kind: "json", index: blockIndex });
    setError(null);

    try {
      const res = await fetch("/api/chunk/json/section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      const item = data.item as IJsonChunkOutputItem | undefined;
      if (!item) {
        setError("Пустой ответ сервера.");
        return;
      }

      clearAnalysisFor("json", blockIndex);
      setResult((prev) => {
        if (prev?.kind !== "json") return prev;
        return {
          kind: "json",
          items: prev.items.map((it, i) => (i === blockIndex ? item : it)),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setRetryingSection(null);
    }
  };

  const handleRetryDocumentPart = async (blockIndex: number) => {
    if (result?.kind !== "document") return;
    const part = result.items[blockIndex]?.part;
    if (part === undefined) return;

    setRetryingSection({ kind: "document", index: blockIndex });
    setError(null);

    try {
      const res = await fetch("/api/chunk/document-part", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: part }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      const item = data.item as IPartWithChunks | undefined;
      if (!item) {
        setError("Пустой ответ сервера.");
        return;
      }

      clearAnalysisFor("document", blockIndex);
      setResult((prev) => {
        if (prev?.kind !== "document") return prev;
        return {
          kind: "document",
          items: prev.items.map((it, i) => (i === blockIndex ? item : it)),
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setRetryingSection(null);
    }
  };

  const handleAnalyzeJsonSection = async (blockIndex: number) => {
    if (result?.kind !== "json") return;
    const item = result.items[blockIndex];
    if (!item?.sourceText || item.chunks.length === 0) return;

    setAnalyzingSection({ kind: "json", index: blockIndex });
    setError(null);

    try {
      const res = await fetch("/api/chunk/json/section/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceText: item.sourceText,
          chunks: item.chunks,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      const analysis = data.analysis as ICoverageAnalysisResult | undefined;
      if (!analysis) {
        setError("Пустой ответ сервера.");
        return;
      }

      setAnalysisByKey((prev) => ({
        ...prev,
        [analysisKey("json", blockIndex)]: analysis,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setAnalyzingSection(null);
    }
  };

  const handleAnalyzeDocumentPart = async (blockIndex: number) => {
    if (result?.kind !== "document") return;
    const item = result.items[blockIndex];
    if (!item?.part || item.chunks.length === 0) return;

    setAnalyzingSection({ kind: "document", index: blockIndex });
    setError(null);

    try {
      const res = await fetch("/api/chunk/document-part/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: item.part,
          chunks: item.chunks,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      const analysis = data.analysis as ICoverageAnalysisResult | undefined;
      if (!analysis) {
        setError("Пустой ответ сервера.");
        return;
      }

      setAnalysisByKey((prev) => ({
        ...prev,
        [analysisKey("document", blockIndex)]: analysis,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setAnalyzingSection(null);
    }
  };

  const isRetrying = (kind: TabId, index: number) =>
    retryingSection?.kind === kind && retryingSection.index === index;

  const isAnalyzing = (kind: TabId, index: number) =>
    analyzingSection?.kind === kind && analyzingSection.index === index;

  const shiftOperationIndexAfterDelete = (kind: TabId, deletedIndex: number) => {
    const shift = (prev: { kind: TabId; index: number } | null) => {
      if (!prev || prev.kind !== kind) return prev;
      if (prev.index === deletedIndex) return null;
      if (prev.index > deletedIndex) return { kind, index: prev.index - 1 };
      return prev;
    };
    setRetryingSection(shift);
    setAnalyzingSection(shift);
  };

  const handleDeleteSection = (kind: TabId, blockIndex: number) => {
    if (!result || result.kind !== kind) return;
    if (!window.confirm("Удалить раздел и все его чанки?")) return;

    shiftOperationIndexAfterDelete(kind, blockIndex);
    setAnalysisByKey((prev) => reindexAnalysisKeys(prev, kind, blockIndex));

    if (kind === "json") {
      setJsonSourceSections((prev) => {
        if (!prev) return null;
        const next = prev.filter((_, i) => i !== blockIndex);
        return next.length === 0 ? null : next;
      });
      setResult((prev) => {
        if (prev?.kind !== "json") return prev;
        const items = prev.items.filter((_, i) => i !== blockIndex);
        return items.length === 0 ? null : { kind: "json", items };
      });
      return;
    }

    setResult((prev) => {
      if (prev?.kind !== "document") return prev;
      const items = prev.items.filter((_, i) => i !== blockIndex);
      return items.length === 0 ? null : { kind: "document", items };
    });
  };

  const handleDeleteChunk = (kind: TabId, sectionIndex: number, chunkIndex: number) => {
    if (!result || result.kind !== kind) return;

    clearAnalysisFor(kind, sectionIndex);

    if (kind === "json") {
      setResult((prev) => {
        if (prev?.kind !== "json") return prev;
        const items = prev.items.map((item, i) =>
          i !== sectionIndex
            ? item
            : { ...item, chunks: item.chunks.filter((_, j) => j !== chunkIndex) }
        );
        return { kind: "json", items };
      });
      return;
    }

    setResult((prev) => {
      if (prev?.kind !== "document") return prev;
      const items = prev.items.map((item, i) =>
        i !== sectionIndex
          ? item
          : { ...item, chunks: item.chunks.filter((_, j) => j !== chunkIndex) }
      );
      return { kind: "document", items };
    });
  };

  const sectionActionDisabled = (kind: TabId, blockIndex: number) =>
    loading || isRetrying(kind, blockIndex) || isAnalyzing(kind, blockIndex);

  const deleteButtonClass =
    "rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-zinc-800 dark:text-red-300 dark:hover:bg-red-950/40";

  const chunkDeleteButtonClass =
    "rounded border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-zinc-800 dark:text-red-300 dark:hover:bg-red-950/40";

  const hasResult = result !== null;

  const handleDownloadChunks = () => {
    if (!result?.items.length) return;
    const itemsWithChunks = result.items.filter((item) => item.chunks.length > 0);
    if (!itemsWithChunks.length) return;
    const json =
      result.kind === "json"
        ? itemsWithChunks
        : itemsWithChunks.flatMap((item) => item.chunks.map((text) => ({ text })));
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chunks.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const tabBtnClass = (tab: TabId) =>
    `rounded-md px-4 py-2 text-sm font-medium transition-colors ${
      activeTab === tab
        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
        : "text-zinc-600 hover:bg-zinc-200/80 dark:text-zinc-400 dark:hover:bg-zinc-800"
    }`;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Разбиение документа на смысловые чанки
        </h1>

        <div
          className="mb-6 flex flex-wrap gap-1 rounded-lg border border-zinc-200 bg-zinc-100/80 p-1 dark:border-zinc-700 dark:bg-zinc-900/80"
          role="tablist"
          aria-label="Источник текста"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "document"}
            className={tabBtnClass("document")}
            onClick={() => handleTabChange("document")}
          >
            Документ
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "json"}
            className={tabBtnClass("json")}
            onClick={() => handleTabChange("json")}
          >
            JSON чанки
          </button>
        </div>

        {activeTab === "document" && (
          <form onSubmit={handleDocumentSubmit} className="mb-6 space-y-4">
            <div>
              <label htmlFor="file-doc" className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Документ (.txt, .doc или .docx)
              </label>
              <input
                id="file-doc"
                type="file"
                accept=".txt,text/plain,.doc,application/msword,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={handleDocumentFileChange}
                disabled={loading}
                className="block w-full max-w-md rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>
            <button
              type="submit"
              disabled={!documentFile || loading}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {loading ? "Обработка…" : "Обработать"}
            </button>
          </form>
        )}

        {activeTab === "json" && (
          <form onSubmit={handleJsonSubmit} className="mb-6 space-y-4">
            <div>
              <label htmlFor="file-json" className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                JSON-файл с массивом объектов
              </label>
              <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                <code>[{"{ number, label, title, text, parents, images? }"}]</code>
              </p>
              <input
                id="file-json"
                type="file"
                accept=".json,application/json"
                onChange={handleJsonFileChange}
                disabled={loading}
                className="block w-full max-w-md rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>
            <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
              Каждый объект должен содержать поля <code>number</code>, <code>label</code>, <code>title</code>,{" "}
              <code>text</code> и массив <code>parents</code>. Опционально — <code>images</code> (как в outline из
              DOCX). В ответе добавляется <code>sourceText</code> и массив <code>chunks</code>: объекты{" "}
              <code>{"{ text, images }"}</code> с полной метой изображений для чанка.
            </p>
            <button
              type="submit"
              disabled={!jsonFile || loading}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {loading ? "Обработка…" : "Обработать"}
            </button>
          </form>
        )}

        {error && (
          <p className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
            {error}
          </p>
        )}

        {hasResult && result && (
          <div className="space-y-10">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Всего чанков: {result.items.reduce((n, item) => n + item.chunks.length, 0)}
                {result.kind === "json" && (
                  <>
                    {" "}
                    · привязок к изображениям:{" "}
                    {result.items.reduce(
                      (n, item) =>
                        n +
                        item.chunks.reduce((m, ch) => m + ch.images.length, 0),
                      0
                    )}
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={handleDownloadChunks}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                Скачать
              </button>
            </div>
            {result.kind === "document" &&
              result.items.map((item, blockIndex) => (
                <div key={blockIndex}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-medium text-zinc-800 dark:text-zinc-200">
                      Часть {blockIndex + 1} (текст для LLM)
                    </h2>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => void handleRetryDocumentPart(blockIndex)}
                        disabled={sectionActionDisabled("document", blockIndex)}
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                      >
                        {isRetrying("document", blockIndex) ? "Повтор…" : "Повтор"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleAnalyzeDocumentPart(blockIndex)}
                        disabled={
                          sectionActionDisabled("document", blockIndex) ||
                          item.chunks.length === 0
                        }
                        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                      >
                        {isAnalyzing("document", blockIndex) ? "Анализ…" : "Анализ"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSection("document", blockIndex)}
                        disabled={sectionActionDisabled("document", blockIndex)}
                        className={deleteButtonClass}
                      >
                        Удалить
                      </button>
                    </div>
                  </div>
                  {analysisByKey[analysisKey("document", blockIndex)] && (
                    <CoverageAnalysisCard
                      analysis={analysisByKey[analysisKey("document", blockIndex)]}
                    />
                  )}
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" style={{ minHeight: "40vh" }}>
                    <section className="flex min-h-0 flex-col">
                      <h3 className="mb-3 text-lg font-medium text-zinc-800 dark:text-zinc-200">
                        Исходный текст
                      </h3>
                      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                        <p className="whitespace-pre-wrap p-4 text-sm text-zinc-800 dark:text-zinc-200">{item.part}</p>
                      </div>
                    </section>
                    <section className="flex min-h-0 flex-col">
                      <h3 className="mb-3 text-lg font-medium text-zinc-800 dark:text-zinc-200">
                        Чанки из этой части ({item.chunks.length})
                      </h3>
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        <ul className="space-y-4">
                          {item.chunks.map((text, i) => (
                            <li
                              key={i}
                              className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
                            >
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                                  Блок {i + 1}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteChunk("document", blockIndex, i)}
                                  disabled={sectionActionDisabled("document", blockIndex)}
                                  className={chunkDeleteButtonClass}
                                >
                                  Удалить
                                </button>
                              </div>
                              <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{text}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </section>
                  </div>
                  {blockIndex < result.items.length - 1 && (
                    <div className="mt-10 border-t-2 border-dashed border-zinc-300 dark:border-zinc-600" aria-hidden />
                  )}
                </div>
              ))}
            {result.kind === "json" &&
              result.items.map((item, blockIndex) => {
                return (
                  <div key={`${item.number}-${blockIndex}`}>
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h2 className="text-lg font-medium text-zinc-800 dark:text-zinc-200">{item.title}</h2>
                        <p className="text-sm text-zinc-600 dark:text-zinc-400">Number: {item.number}</p>
                        {item.parents.length > 0 && (
                          <p className="text-sm text-zinc-600 dark:text-zinc-400">
                            Родители: {item.parents.map((parent) => parent.title).join(" / ")}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => void handleRetryJsonSection(blockIndex)}
                          disabled={
                            sectionActionDisabled("json", blockIndex) || !jsonSourceSections
                          }
                          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          {isRetrying("json", blockIndex) ? "Повтор…" : "Повтор"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleAnalyzeJsonSection(blockIndex)}
                          disabled={
                            sectionActionDisabled("json", blockIndex) ||
                            item.chunks.length === 0
                          }
                          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          {isAnalyzing("json", blockIndex) ? "Анализ…" : "Анализ"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSection("json", blockIndex)}
                          disabled={sectionActionDisabled("json", blockIndex)}
                          className={deleteButtonClass}
                        >
                          Удалить
                        </button>
                      </div>
                    </div>
                    {analysisByKey[analysisKey("json", blockIndex)] && (
                      <CoverageAnalysisCard analysis={analysisByKey[analysisKey("json", blockIndex)]} />
                    )}
                    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" style={{ minHeight: "40vh" }}>
                      <section className="flex min-h-0 flex-col">
                        <h3 className="mb-3 text-lg font-medium text-zinc-800 dark:text-zinc-200">
                          Исходный text
                        </h3>
                        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                          <p className="whitespace-pre-wrap p-4 text-sm text-zinc-800 dark:text-zinc-200">
                            {item.sourceText || "Исходный текст недоступен."}
                          </p>
                        </div>
                      </section>
                      <section className="flex min-h-0 flex-col">
                        <h3 className="mb-3 text-lg font-medium text-zinc-800 dark:text-zinc-200">
                          Чанки ({item.chunks.length}
                          {item.chunks.length > 0
                            ? ` · изобр.: ${item.chunks.reduce((n, ch) => n + ch.images.length, 0)}`
                            : ""}
                          )
                        </h3>
                        <div className="min-h-0 flex-1 overflow-y-auto">
                          <ul className="space-y-4">
                            {item.chunks.map((chunk, i) => (
                              <li
                                key={i}
                                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
                              >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                                    Блок {i + 1}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteChunk("json", blockIndex, i)}
                                    disabled={sectionActionDisabled("json", blockIndex)}
                                    className={chunkDeleteButtonClass}
                                  >
                                    Удалить
                                  </button>
                                </div>
                                <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
                                  {chunk.text}
                                </p>
                                {chunk.images.length > 0 && (
                                  <div className="mt-3 space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-600">
                                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                      Связанные изображения
                                    </p>
                                    <ul className="space-y-2">
                                      {chunk.images.map((img) => (
                                        <li
                                          key={img.img}
                                          className="rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-800/80"
                                        >
                                          <span className="mr-2 inline-block rounded bg-zinc-200 px-1.5 py-0.5 font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                                            {img.type === "icon" ? "Иконка" : "Скриншот"}
                                          </span>
                                          <span className="font-medium text-zinc-800 dark:text-zinc-100">
                                            {img.name}
                                          </span>
                                          <p className="mt-1 text-zinc-600 dark:text-zinc-300">{img.llmname}</p>
                                          <p className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                                            {img.img}
                                          </p>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </section>
                    </div>
                    {blockIndex < result.items.length - 1 && (
                      <div className="mt-10 border-t-2 border-dashed border-zinc-300 dark:border-zinc-600" aria-hidden />
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </main>
    </div>
  );
}
