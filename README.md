## Визуальный тест: merge чанков из JSON

Используйте команду ниже, чтобы объединить чанки из нескольких JSON-файлов и сохранить результат в отдельный JSON:

```bash
npm run merge:chunks -- run1.json run2.json -o merged.visual.json
```

### Форматы входных файлов

Каждый входной файл может быть в одном из форматов:

- `["chunk 1", "chunk 2"]`
- `[["run1 chunk 1"], ["run2 chunk 1", "run2 chunk 2"]]`
- `{ "chunks": ["chunk 1", "chunk 2"] }`
- `{ "runs": [["run1 chunk 1"], ["run2 chunk 1"]] }`

### Что в выходном файле

В выходном файле (например, `merged.visual.json`) будут поля:

- `inputFiles` — абсолютные пути обработанных файлов
- `runsCount` — общее число прогонов, собранных из всех входов
- `mergedChunksCount` — количество итоговых объединенных чанков
- `mergedChunks` — финальный список объединенных чанков

### Важно

- Для объединения используется `mergeChunksSemantically` из `app/api/chunk/chunkMergeService.ts`.
- Нужен запущенный embedding-сервис (`EMBEDDING_API_URL`), так как семантический merge зависит от эмбеддингов.
- По умолчанию используется `http://127.0.0.1:8000/embed` и роль `passage` (можно переопределить через `EMBEDDING_API_ROLE`).
