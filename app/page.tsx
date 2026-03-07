"use client";

import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [partsWithChunks, setPartsWithChunks] = useState<{ part: string; chunks: string[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setFile(f ?? null);
    setPartsWithChunks(null);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!file) return;

    setLoading(true);
    setError(null);
    setPartsWithChunks(null);

    try {
      const formData = new FormData();
      formData.set("file", file);

      const res = await fetch("/api/chunk", {
        method: "POST",
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      setPartsWithChunks(data.partsWithChunks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const hasResult = partsWithChunks !== null;

  const handleDownloadChunks = () => {
    if (!partsWithChunks?.length) return;
    const allChunks = partsWithChunks.flatMap((item) => item.chunks);
    const json = allChunks.map((text) => ({ text }));
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chunks.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Разбиение документа на смысловые чанки
        </h1>

        <form onSubmit={handleSubmit} className="mb-6 space-y-4">
          <div>
            <label htmlFor="file" className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Документ (.txt или .docx)
            </label>
            <input
              id="file"
              type="file"
              accept=".txt,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleFileChange}
              disabled={loading}
              className="block w-full max-w-md rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          <button
            type="submit"
            disabled={!file || loading}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {loading ? "Обработка…" : "Обработать"}
          </button>
        </form>

        {error && (
          <p className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200">
            {error}
          </p>
        )}

        {hasResult && partsWithChunks && (
          <div className="space-y-10">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Всего чанков: {partsWithChunks.reduce((n, item) => n + item.chunks.length, 0)}
              </p>
              <button
                type="button"
                onClick={handleDownloadChunks}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                Скачать
              </button>
            </div>
            {partsWithChunks.map((item, blockIndex) => (
              <div key={blockIndex}>
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" style={{ minHeight: "40vh" }}>
                  <section className="flex min-h-0 flex-col">
                    <h2 className="mb-3 text-lg font-medium text-zinc-800 dark:text-zinc-200">
                      Часть {blockIndex + 1} (текст)
                    </h2>
                    <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                      <p className="whitespace-pre-wrap p-4 text-sm text-zinc-800 dark:text-zinc-200">{item.part}</p>
                    </div>
                  </section>
                  <section className="flex min-h-0 flex-col">
                    <h2 className="mb-3 text-lg font-medium text-zinc-800 dark:text-zinc-200">
                      Чанки из этой части ({item.chunks.length})
                    </h2>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <ul className="space-y-4">
                        {item.chunks.map((text, i) => (
                          <li
                            key={i}
                            className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
                          >
                            <span className="mb-2 block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                              Блок {i + 1}
                            </span>
                            <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{text}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </section>
                </div>
                {blockIndex < partsWithChunks.length - 1 && (
                  <div className="mt-10 border-t-2 border-dashed border-zinc-300 dark:border-zinc-600" aria-hidden />
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
