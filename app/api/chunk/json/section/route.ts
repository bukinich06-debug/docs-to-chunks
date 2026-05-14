import { ChunkError } from "@/app/api/chunk/chunkService";
import { chunkSingleJsonSection } from "../chunkJsonService";
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

  const section = (body as Record<string, unknown>).section;
  if (section === undefined) {
    return NextResponse.json({ error: "Missing \"section\" field" }, { status: 400 });
  }

  try {
    const item = await chunkSingleJsonSection(section);
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
