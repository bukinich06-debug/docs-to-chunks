import { ChunkError, chunkDocument } from "@/app/api/chunk/chunkService";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid form data" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "No file provided" },
      { status: 400 }
    );
  }

  try {
    const result = await chunkDocument(file);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ChunkError) {
      return NextResponse.json(
        { error: e.message },
        { status: e.statusCode }
      );
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
