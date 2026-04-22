import { buildDocxOutline } from "@/app/api/docx-outline/docxOutlineService";
import { outlineJsonBaseName } from "@/lib/outlineOutput";
import JSZip from "jszip";
import { NextResponse } from "next/server";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function isDocxFile(file: File): boolean {
  return (
    file.type === DOCX_MIME ||
    file.name.toLowerCase().endsWith(".docx")
  );
}

function contentDispositionAttachment(downloadName: string): string {
  const encoded = encodeURIComponent(downloadName);
  const ascii =
    downloadName.replace(/[^\x20-\x7E]/g, "_").replace(/_+/g, "_") ||
    "outline.zip";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

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

  if (!isDocxFile(file)) {
    return NextResponse.json(
      { error: "Нужен файл .docx" },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { items, mediaFiles } = await buildDocxOutline(buffer);

    const zip = new JSZip();
    zip.file("outline.json", JSON.stringify(items, null, 2));
    for (const [path, buf] of mediaFiles) {
      zip.file(path, buf);
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const zipName = `${outlineJsonBaseName(file.name, "docx")}-outline.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDispositionAttachment(zipName),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const isUserError =
      message.includes("не найдено") || message.includes("заголовков");
    return NextResponse.json(
      { error: message },
      { status: isUserError ? 400 : 500 }
    );
  }
}
