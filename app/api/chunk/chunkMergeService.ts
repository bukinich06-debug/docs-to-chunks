const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL;
const EMBEDDING_API_ROLE = "passage";
const EMBEDDING_API_TIMEOUT_MS = 15_000;

const STRICT_DUPLICATE_SIMILARITY = 0.9;
const BORDERLINE_DUPLICATE_SIMILARITY = 0.84;
const AGGREGATOR_SIMILARITY = 0.86;
const AGGREGATOR_LENGTH_RATIO = 1.6;

type MergeCandidate = {
  text: string;
  canonical: string;
  firstSeenOrder: number;
  tokenCount: number;
  occurrences: number;
  runSet: Set<number>;
  embedding?: number[];
};

// Нормализует чанк: убирает ведущую/хвостовую пунктуацию и лишние пробелы.
function normalizeChunk(text: string): string {
  return text
    .replace(/^[\s'\"\-–—.,:;]+/, "")
    .replace(/[\s'\"\-–—.,:;]+$/, "")
    .trim();
}

// Применяет постобработку к списку чанков и отфильтровывает пустые строки.
function postProcessChunks(chunks: string[]): string[] {
  return chunks
    .map(normalizeChunk)
    .filter((s) => s.length > 0);
}

// Приводит чанк к канонической форме для дедупликации по тексту.
function canonicalizeChunk(text: string): string {
  return normalizeChunk(text).toLowerCase().replace(/\s+/g, " ");
}

// Токенизирует строку для вычисления лексического сходства.
function tokenizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

// Считает долю общих токенов относительно меньшего множества токенов.
function lexicalOverlapScore(a: string, b: string): number {
  const aTokens = new Set(tokenizeForSimilarity(a));
  const bTokens = new Set(tokenizeForSimilarity(b));
  if (aTokens.size === 0 || bTokens.size === 0) {
    return 0;
  }

  let common = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      common++;
    }
  }

  return common / Math.min(aTokens.size, bTokens.size);
}

// Вычисляет косинусное сходство двух эмбеддингов.
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let aNormSq = 0;
  let bNormSq = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aNormSq += a[i] * a[i];
    bNormSq += b[i] * b[i];
  }

  if (aNormSq === 0 || bNormSq === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aNormSq) * Math.sqrt(bNormSq));
}

// Определяет, считаются ли два кандидата семантическими дубликатами.
function isSemanticDuplicate(a: MergeCandidate, b: MergeCandidate, sim: number): boolean {
  if (sim >= STRICT_DUPLICATE_SIMILARITY) {
    return true;
  }
  if (sim < BORDERLINE_DUPLICATE_SIMILARITY) {
    return false;
  }

  const overlap = lexicalOverlapScore(a.text, b.text);
  const shorter = Math.min(a.tokenCount, b.tokenCount);
  const longer = Math.max(a.tokenCount, b.tokenCount);
  const lengthRatio = shorter / longer;
  return overlap >= 0.45 && lengthRatio >= 0.55;
}

// Проверяет, является ли "широкий" чанк агрегатором для более "узкого".
function isAggregatorCandidate(broad: MergeCandidate, narrow: MergeCandidate, sim: number): boolean {
  if (sim < AGGREGATOR_SIMILARITY) {
    return false;
  }
  if (broad.tokenCount < Math.ceil(narrow.tokenCount * AGGREGATOR_LENGTH_RATIO)) {
    return false;
  }
  return lexicalOverlapScore(broad.text, narrow.text) >= 0.25;
}

// Запрашивает эмбеддинг чанка у внешнего сервиса с таймаутом и валидацией ответа.
async function getEmbeddingForChunk(text: string): Promise<number[]> {
  const embeddingApiUrl = (EMBEDDING_API_URL ?? "").trim();
  if (!embeddingApiUrl) {
    throw new Error(
      "Embedding API URL is empty. Set EMBEDDING_API_URL to a valid endpoint."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_API_TIMEOUT_MS);

  try {
    const res = await fetch(embeddingApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        role: EMBEDDING_API_ROLE,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding service returned ${res.status}: ${body}`);
    }

    const payload = (await res.json()) as {
      embedding?: unknown;
      dim?: unknown;
      model?: unknown;
    };
    if (!Array.isArray(payload.embedding)) {
      throw new Error("Embedding service did not return a valid 'embedding' array");
    }

    const embedding = payload.embedding
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (embedding.length === 0) {
      throw new Error("Embedding service returned an empty embedding");
    }
    if (payload.dim !== undefined) {
      const dim = Number(payload.dim);
      if (Number.isFinite(dim) && dim > 0 && embedding.length !== dim) {
        throw new Error(
          `Embedding dimension mismatch: expected ${dim}, got ${embedding.length}`
        );
      }
    }

    return embedding;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new Error(`Embedding request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

// Объединяет чанки из нескольких прогонов по семантическому сходству.
export async function mergeChunksSemantically(runs: string[][]): Promise<string[]> {
  if (!Array.isArray(runs) || runs.length === 0) {
    return [];
  }

  const byCanonical = new Map<string, MergeCandidate>();
  let order = 0;

  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = runs[runIndex] ?? [];
    for (const rawChunk of run) {
      const text = normalizeChunk(rawChunk);
      if (!text) continue;

      const canonical = canonicalizeChunk(text);
      const existing = byCanonical.get(canonical);
      if (existing) {
        existing.occurrences += 1;
        existing.runSet.add(runIndex);
        continue;
      }

      byCanonical.set(canonical, {
        text,
        canonical,
        firstSeenOrder: order++,
        tokenCount: tokenizeForSimilarity(text).length,
        occurrences: 1,
        runSet: new Set([runIndex]),
      });
    }
  }

  const candidates = Array.from(byCanonical.values()).sort(
    (a, b) => a.firstSeenOrder - b.firstSeenOrder
  );
  if (candidates.length <= 1) {
    return postProcessChunks(candidates.map((candidate) => candidate.text));
  }

  const embeddingCache = new Map<string, number[]>();
  await Promise.all(
    candidates.map(async (candidate) => {
      const cached = embeddingCache.get(candidate.canonical);
      if (cached) {
        candidate.embedding = cached;
        return;
      }
      const embedding = await getEmbeddingForChunk(candidate.text);
      embeddingCache.set(candidate.canonical, embedding);
      candidate.embedding = embedding;
    })
  );

  const parent = Array.from({ length: candidates.length }, (_, i) => i);
  // Находит корень множества с сжатием пути (DSU/Union-Find).
  const find = (idx: number): number => {
    if (parent[idx] !== idx) {
      parent[idx] = find(parent[idx]);
    }
    return parent[idx];
  };

  // Объединяет два множества кандидатов в DSU.
  const union = (aIdx: number, bIdx: number): void => {
    const rootA = find(aIdx);
    const rootB = find(bIdx);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const sim = cosineSimilarity(candidates[i].embedding ?? [], candidates[j].embedding ?? []);
      if (isSemanticDuplicate(candidates[i], candidates[j], sim)) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) {
      group.push(i);
    } else {
      groups.set(root, [i]);
    }
  }

  const representativeIndices = Array.from(groups.values()).map((groupIndices) => {
    return groupIndices.sort((aIdx, bIdx) => {
      const a = candidates[aIdx];
      const b = candidates[bIdx];
      if (b.runSet.size !== a.runSet.size) return b.runSet.size - a.runSet.size;
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
      return a.firstSeenOrder - b.firstSeenOrder;
    })[0];
  });

  const droppedAggregators = new Set<number>();
  for (const broadIdx of representativeIndices) {
    const broad = candidates[broadIdx];
    const narrowMatches = representativeIndices.filter((narrowIdx) => {
      if (narrowIdx === broadIdx) return false;
      const narrow = candidates[narrowIdx];
      const sim = cosineSimilarity(broad.embedding ?? [], narrow.embedding ?? []);
      return isAggregatorCandidate(broad, narrow, sim);
    });
    if (narrowMatches.length < 2) continue;

    let hasDiverseNarrowPair = false;
    for (let i = 0; i < narrowMatches.length && !hasDiverseNarrowPair; i++) {
      for (let j = i + 1; j < narrowMatches.length; j++) {
        const sim = cosineSimilarity(
          candidates[narrowMatches[i]].embedding ?? [],
          candidates[narrowMatches[j]].embedding ?? []
        );
        if (sim < BORDERLINE_DUPLICATE_SIMILARITY) {
          hasDiverseNarrowPair = true;
          break;
        }
      }
    }

    if (hasDiverseNarrowPair) {
      droppedAggregators.add(broadIdx);
    }
  }

  const kept = new Set<number>(
    representativeIndices.filter((idx) => !droppedAggregators.has(idx))
  );

  // Coverage guarantee: if a source chunk has no semantic substitute, keep it.
  for (let i = 0; i < candidates.length; i++) {
    if (kept.has(i)) continue;

    const source = candidates[i];
    let covered = false;
    for (const keptIdx of kept) {
      const target = candidates[keptIdx];
      const sim = cosineSimilarity(source.embedding ?? [], target.embedding ?? []);
      if (isSemanticDuplicate(source, target, sim)) {
        covered = true;
        break;
      }
    }

    if (!covered) {
      kept.add(i);
    }
  }

  return postProcessChunks(
    Array.from(kept)
      .sort((aIdx, bIdx) => candidates[aIdx].firstSeenOrder - candidates[bIdx].firstSeenOrder)
      .map((idx) => candidates[idx].text)
  );
}
