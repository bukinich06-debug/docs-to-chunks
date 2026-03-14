import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { mergeChunksSemantically } from "../app/api/chunk/chunkMergeService";

type ParsedInput = {
  runs: string[][];
  sourcePath: string;
};

// Показывает справку по запуску CLI и поддерживаемым форматам входного JSON.
function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npm run merge:chunks -- <input1.json> [input2.json ...] [-o output.json]",
      "",
      "Supported input JSON formats:",
      '  - ["chunk 1", "chunk 2"]',
      '  - [["run1 chunk 1"], ["run2 chunk 1", "run2 chunk 2"]]',
      '  - { "chunks": ["chunk 1", "chunk 2"] }',
      '  - { "runs": [["run1 chunk 1"], ["run2 chunk 1"]] }',
    ].join("\n")
  );
}

// Нормализует массив строк: приводит элементы к строке, обрезает пробелы и удаляет пустые.
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
    .filter(Boolean);
}

// Извлекает массив прогонов (runs) из разных форматов входного JSON.
function extractRuns(payload: unknown): string[][] {
  if (Array.isArray(payload)) {
    if (payload.every((item) => typeof item === "string")) {
      return [normalizeStringArray(payload)];
    }

    if (payload.every((item) => Array.isArray(item))) {
      return payload
        .map((run) => normalizeStringArray(run))
        .filter((run) => run.length > 0);
    }
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;

    if (Array.isArray(record.runs)) {
      return extractRuns(record.runs);
    }

    if (Array.isArray(record.chunks)) {
      return [normalizeStringArray(record.chunks)];
    }
  }

  return [];
}

// Разбирает аргументы CLI: входные файлы и опциональный путь выходного файла.
function parseArgs(argv: string[]): { inputPaths: string[]; outputPath: string } {
  const inputPaths: string[] = [];
  let outputPath = "merged-chunks.output.json";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Output path is missing after -o/--output.");
      }
      outputPath = value;
      i++;
      continue;
    }

    inputPaths.push(arg);
  }

  return { inputPaths, outputPath };
}

// Читает входной JSON-файл, валидирует его формат и возвращает нормализованные runs.
async function readInputFile(inputPath: string): Promise<ParsedInput> {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  const raw = await readFile(absolutePath, "utf-8");
  const payload = JSON.parse(raw) as unknown;
  const runs = extractRuns(payload);

  if (runs.length === 0) {
    throw new Error(
      `File "${inputPath}" does not contain valid chunks/runs. See usage for supported formats.`
    );
  }

  return { runs, sourcePath: absolutePath };
}

// Точка входа CLI: собирает runs, запускает mergeChunksSemantically и пишет результат в файл.
async function main(): Promise<void> {
  const { inputPaths, outputPath } = parseArgs(process.argv.slice(2));

  if (inputPaths.length === 0) {
    printUsage();
    throw new Error("Provide at least one input JSON file.");
  }

  const parsedInputs = await Promise.all(inputPaths.map((filePath) => readInputFile(filePath)));
  const allRuns = parsedInputs.flatMap((item) => item.runs);

  if (allRuns.length === 0) {
    throw new Error("No runs found in provided files.");
  }

  const mergedChunks = await mergeChunksSemantically(allRuns);
  const absoluteOutputPath = path.resolve(process.cwd(), outputPath);

  const output = {
    inputFiles: parsedInputs.map((item) => item.sourcePath),
    runsCount: allRuns.length,
    mergedChunksCount: mergedChunks.length,
    mergedChunks,
  };

  await writeFile(absoluteOutputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

  console.log(`Merged ${allRuns.length} run(s) into ${mergedChunks.length} chunk(s).`);
  console.log(`Saved output JSON: ${absoluteOutputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[merge:chunks] ${message}`);
  process.exitCode = 1;
});
