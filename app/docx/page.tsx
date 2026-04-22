"use client";

import {
  downloadBlob,
  outlineJsonBaseName,
  type OutputItem,
} from "@/lib/outlineOutput";
import JSZip from "jszip";
import { useState, type ChangeEvent, type FormEvent } from "react";

export default function DocxPage() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OutputItem[] | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    setError(null);
    setResult(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!file) {
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.set("file", file);

      const res = await fetch("/api/docx-outline", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const errMsg =
          data &&
          typeof data === "object" &&
          "error" in data &&
          typeof (data as { error: unknown }).error === "string"
            ? (data as { error: string }).error
            : `Ошибка ${res.status}`;
        throw new Error(errMsg);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("zip")) {
        throw new Error("Ожидался архив ZIP от сервера.");
      }

      const blob = await res.blob();
      const zipName = `${outlineJsonBaseName(file.name, "docx")}-outline.zip`;
      downloadBlob(zipName, blob);

      const zip = await JSZip.loadAsync(blob);
      const jsonEntry = zip.file("outline.json");
      if (!jsonEntry) {
        throw new Error("В архиве нет outline.json.");
      }
      const jsonStr = await jsonEntry.async("string");
      const parsed: unknown = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        throw new Error("Некорректный outline.json в архиве.");
      }

      const output = parsed as OutputItem[];
      setResult(output);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось обработать DOCX."
      );
    } finally {
      setLoading(false);
    }
  };

  const previewJson = result ? JSON.stringify(result, null, 2) : null;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-zinc-950">
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          DOCX Outline JSON
        </h1>
        <p className="mb-6 max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Загрузите .docx со стилями заголовков (Heading / Заголовок 1–6). Страница
          соберёт плоский JSON разделов (как для PDF), извлечёт встроенные рисунки
          (подпись — следующий абзац после блока с картинкой) и скачает ZIP:
          outline.json и папка media с файлами; в JSON в каждом разделе поле{" "}
          <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">images</code>{" "}
          с относительными путями.
        </p>

        <form onSubmit={handleSubmit} className="mb-6 space-y-4">
          <div>
            <label
              htmlFor="docx-file"
              className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              DOCX файл
            </label>
            <input
              id="docx-file"
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
            {loading ? "Обработка..." : "Обработать и скачать ZIP"}
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
                Архив скачан. Превью outline.json: разделов {result.length}.
              </p>
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
