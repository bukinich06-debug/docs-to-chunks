import { ChunkError, chunkDocumentPart } from "@/app/api/chunk/chunkService";
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

  const text = (body as Record<string, unknown>).text;
  if (typeof text !== "string") {
    return NextResponse.json({ error: "Missing or invalid \"text\" field" }, { status: 400 });
  }

  try {
    const item = await chunkDocumentPart(text);
    return NextResponse.json({ item });
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
