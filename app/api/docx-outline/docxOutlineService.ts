import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import mammoth from "mammoth";

import {
  sanitizeTitle,
  toParentItem,
  type OutlineSectionImage,
  type OutputItem,
  type ParentItem,
} from "@/lib/outlineOutput";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

export type DocxOutlineBuildResult = {
  items: OutputItem[];
  mediaFiles: Map<string, Buffer>;
};

function headingLevel(tagName: string): number {
  const m = /^h([1-6])$/i.exec(tagName);
  return m ? Number.parseInt(m[1], 10) : 6;
}

function buildLocalizedHeadingStyleMap(): string[] {
  const lines: string[] = [];
  for (let i = 1; i <= 6; i += 1) {
    lines.push(`p[style-name='Заголовок ${i}'] => h${i}:fresh`);
    lines.push(`p[style-name='Heading ${i}'] => h${i}:fresh`);
  }
  return lines;
}

function normalizeBlockText(text: string): string {
  return text
    .replace(/([A-Za-zА-Яа-яЁё])-\s+([A-Za-zА-Яа-яЁё])/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripLeadingTitleDuplicate(body: string, title: string): string {
  const t = title.trim();
  if (!t || !body) {
    return body;
  }

  const lines = body.split("\n");
  const first = lines[0]?.trim();
  if (first && first === t) {
    return lines.slice(1).join("\n").trimStart();
  }

  if (body.trimStart().toLowerCase().startsWith(t.toLowerCase() + "\n")) {
    return body.trimStart().slice(t.length).trimStart();
  }

  return body;
}

function blockElementsToText(
  $: cheerio.CheerioAPI,
  $els: cheerio.Cheerio<AnyNode>
): string {
  const parts: string[] = [];
  $els.each((_i, el) => {
    if (el.type !== "tag") {
      return;
    }
    const name = el.tagName.toLowerCase();
    if (name === "ul" || name === "ol") {
      $(el)
        .find("li")
        .each((_j, li) => {
          const chunk = $(li).text().trim();
          if (chunk) {
            parts.push(chunk);
          }
        });
      return;
    }
    if (name === "table") {
      $(el)
        .find("tr")
        .each((_j, tr) => {
          const chunk = $(tr).text().replace(/\s+/g, " ").trim();
          if (chunk) {
            parts.push(chunk);
          }
        });
      return;
    }
    const chunk = $(el).text().trim();
    if (chunk) {
      parts.push(chunk);
    }
  });
  return normalizeBlockText(parts.join("\n\n"));
}

function parseDataUrl(src: string): { contentType: string; buffer: Buffer } | null {
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(src.trim());
  if (!m) {
    return null;
  }
  const contentType = m[1].trim().toLowerCase();
  try {
    const buffer = Buffer.from(m[2], "base64");
    return { contentType, buffer };
  } catch {
    return null;
  }
}

function mimeToExtension(contentType: string): string {
  if (contentType === "image/png") {
    return "png";
  }
  if (contentType === "image/jpeg" || contentType === "image/jpg") {
    return "jpg";
  }
  if (contentType === "image/gif") {
    return "gif";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/bmp") {
    return "bmp";
  }
  if (contentType === "image/svg+xml") {
    return "svg";
  }
  return "bin";
}

function* nodesInDocumentOrder(root: Element): Generator<AnyNode> {
  function* walk(n: AnyNode): Generator<AnyNode> {
    if (n.type === "text") {
      yield n;
      return;
    }
    if (n.type === "tag") {
      yield n;
      for (const c of n.children) {
        yield* walk(c);
      }
    }
  }
  for (const c of root.children) {
    yield* walk(c);
  }
}

/** Текст в том же блоке, что и img, после тега (подпись «Рисунок N — …» в одном p с картинкой). */
function textAfterImgInBlock(blockEl: Element, imgEl: Element): string {
  const parts: string[] = [];
  let found = false;
  for (const node of nodesInDocumentOrder(blockEl)) {
    if (node === imgEl) {
      found = true;
      continue;
    }
    if (found && node.type === "text") {
      const t = node.data.replace(/\u00a0/g, " ").trim();
      if (t) {
        parts.push(t);
      }
    }
  }
  return parts.join(" ").replace(/[ \t]+/g, " ").trim();
}

function collectSectionImages(
  $: cheerio.CheerioAPI,
  topLevelNodes: AnyNode[],
  sectionIndex: number,
  mediaFiles: Map<string, Buffer>
): OutlineSectionImage[] {
  const siblings = topLevelNodes.filter((n): n is Element => n.type === "tag");
  const images: OutlineSectionImage[] = [];
  let imgIndexInSection = 0;

  for (let si = 0; si < siblings.length; si += 1) {
    const el = siblings[si];
    const tag = el.tagName.toLowerCase();
    const $el = $(el);
    const imgsInBlock: Element[] =
      tag === "img" ? [el] : $el.find("img").toArray();

    for (const imgEl of imgsInBlock) {
      if (imgEl.type !== "tag" || imgEl.tagName.toLowerCase() !== "img") {
        continue;
      }
      const src = $(imgEl).attr("src");
      if (!src?.startsWith("data:")) {
        continue;
      }
      const parsed = parseDataUrl(src);
      if (!parsed || parsed.buffer.length === 0) {
        continue;
      }

      const ext = mimeToExtension(parsed.contentType);
      const relPath = `media/s${sectionIndex}-i${imgIndexInSection}.${ext}`;
      imgIndexInSection += 1;
      mediaFiles.set(relPath, parsed.buffer);

      let name = `image-s${sectionIndex}-i${imgIndexInSection - 1}`;
      const inlineCaption =
        tag === "img" ? "" : textAfterImgInBlock(el, imgEl).trim();
      if (inlineCaption) {
        name = inlineCaption;
      } else {
        const next = siblings[si + 1];
        if (next && next.type === "tag" && next.tagName.toLowerCase() === "p") {
          const cap = $(next).text().trim();
          if (cap) {
            name = cap;
          }
        }
      }

      images.push({ name, img: relPath });
    }
  }

  return images;
}

export async function buildDocxOutline(
  buffer: Buffer
): Promise<DocxOutlineBuildResult> {
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      styleMap: buildLocalizedHeadingStyleMap(),
      convertImage: mammoth.images.imgElement((image) =>
        image.read("base64").then((imageBase64) => ({
          src: `data:${image.contentType};base64,${imageBase64}`,
        }))
      ),
    }
  );

  const wrapped = `<div id="mammoth-root">${html}</div>`;
  const $ = cheerio.load(wrapped);
  const root = $("#mammoth-root");
  const headings = root.find(HEADING_SELECTOR).toArray();

  if (!headings.length) {
    throw new Error(
      "В документе не найдено стилей заголовков (Heading 1–6 / Заголовок 1–6)."
    );
  }

  const mediaFiles = new Map<string, Buffer>();
  const stack: { level: number; item: ParentItem }[] = [];
  const output: OutputItem[] = [];

  const $first = $(headings[0]);
  const preambleSiblings = $first.prevAll().toArray().reverse();
  const preamble = blockElementsToText($, $(preambleSiblings));

  for (let i = 0; i < headings.length; i += 1) {
    const el = headings[i];
    const level = headingLevel(el.tagName);
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const parents = stack.map((s) => s.item);
    const headingTitle = sanitizeTitle($(el).text());
    const currentItem = toParentItem(headingTitle);

    const $between = $(el).nextUntil(HEADING_SELECTOR);
    let text = blockElementsToText($, $between);
    text = stripLeadingTitleDuplicate(text, headingTitle);
    if (i === 0 && preamble) {
      text = text ? `${preamble}\n\n${text}` : preamble;
    }

    const betweenNodes = $between.toArray();
    const sectionNodes =
      i === 0 ? [...preambleSiblings, ...betweenNodes] : betweenNodes;
    const images = collectSectionImages($, sectionNodes, i, mediaFiles);

    stack.push({ level, item: currentItem });

    const item: OutputItem = {
      number: currentItem.number,
      label: currentItem.label,
      title: headingTitle,
      text,
      parents,
    };
    if (images.length) {
      item.images = images;
    }
    output.push(item);
  }

  return { items: output, mediaFiles };
}
