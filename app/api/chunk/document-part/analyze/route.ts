import { ChunkError } from "@/app/api/chunk/chunkService";
import { analyzeDocumentPartCoverage } from "@/app/api/chunk/chunkAnalysisService";
import { NextResponse } from "next/server";

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
  const text = record.text;
  const chunks = record.chunks;

  if (typeof text !== "string") {
    return NextResponse.json({ error: "Missing or invalid \"text\" field" }, { status: 400 });
  }

  if (!Array.isArray(chunks) || !chunks.every((c) => typeof c === "string")) {
    return NextResponse.json({ error: "Missing or invalid \"chunks\" field" }, { status: 400 });
  }

  try {
    const analysis = await analyzeDocumentPartCoverage(text, chunks);
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
