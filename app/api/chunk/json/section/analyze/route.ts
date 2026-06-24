import { ChunkError } from "@/app/api/chunk/chunkService";
import { analyzeJsonSectionCoverage } from "@/app/api/chunk/chunkAnalysisService";
import type { IJsonOutputChunk } from "@/app/api/chunk/json/types";
import { NextResponse } from "next/server";

function isJsonOutputChunk(value: unknown): value is IJsonOutputChunk {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.text === "string" && Array.isArray(o.images);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  const sourceText = record.sourceText;
  const chunks = record.chunks;

  if (typeof sourceText !== "string") {
    return NextResponse.json({ error: "Missing or invalid \"sourceText\" field" }, { status: 400 });
  }

  if (!Array.isArray(chunks)) {
    return NextResponse.json({ error: "Missing or invalid \"chunks\" field" }, { status: 400 });
  }

  if (!chunks.every(isJsonOutputChunk)) {
    return NextResponse.json(
      { error: "Each chunk must be an object with \"text\" and \"images\" fields" },
      { status: 400 }
    );
  }

  try {
    const analysis = await analyzeJsonSectionCoverage(sourceText, chunks);
    return NextResponse.json({ analysis });
  } catch (e) {
    if (e instanceof ChunkError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
