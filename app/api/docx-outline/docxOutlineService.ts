import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import mammoth from "mammoth";

import {
  sanitizeTitle,
  toParentItem,
  type ImageLlmType,
  type OutlineSectionImage,
  type OutputItem,
  type ParentItem,
} from "@/lib/outlineOutput";
import { fetchImageMetadataFromLlm } from "@shared/api/llmChatCompletions";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

const IMAGE_DESCRIPTION_START = "\n⟦img⟧\n";
const IMAGE_DESCRIPTION_END = "\n⟦/img⟧\n";
const ICON_DESCRIPTION_START = "\n⟦icon⟧\n";
const ICON_DESCRIPTION_END = "\n⟦/icon⟧\n";

function imageDescriptionStartWithPath(relPath: string): string {
  const p = relPath.trim();
  if (!p) return IMAGE_DESCRIPTION_START;
  return `\n⟦img path="${p}"⟧\n`;
}

function escapeIconDelimiterAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function iconDescriptionStartWithPath(relPath: string, llmname: string): string {
  const p = relPath.trim();
  const nameEscaped = escapeIconDelimiterAttr(llmname.trim());
  if (!p && !llmname.trim()) return ICON_DESCRIPTION_START;
  const attrs: string[] = [];
  if (p) attrs.push(`path="${escapeIconDelimiterAttr(p)}"`);
  attrs.push(`name="${nameEscaped}"`);
  return `\n⟦icon ${attrs.join(" ")}⟧\n`;
}

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
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg" || contentType === "image/jpg") return "jpg";
  if (contentType === "image/gif") return "gif";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/bmp") return "bmp";
  if (contentType === "image/svg+xml") return "svg";
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

function normalizeCaptionText(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
}

/** Подпись к рисунку в стиле «Рис. …» / «Рисунок …». */
function isFigureCaption(text: string): boolean {
  const t = normalizeCaptionText(text);
  if (!t) return false;
  return /^Рис\./i.test(t) || /^Рисунок\b/i.test(t);
}

/**
 * Ищет в элементе-соседе (p / обёртка / li) первый текст, похожий на подпись к рисунку.
 */
function firstFigureCaptionInSiblingEl($: cheerio.CheerioAPI, el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "p") {
    const t = normalizeCaptionText($(el).text());
    return t && isFigureCaption(t) ? t : null;
  }
  if (tag === "div" || tag === "center" || tag === "li") {
    for (const p of $(el).find("p").toArray()) {
      const t = normalizeCaptionText($(p).text());
      if (t && isFigureCaption(t)) return t;
    }
    const t = normalizeCaptionText($(el).text());
    return t && isFigureCaption(t) ? t : null;
  }
  return null;
}

function blockSubtreeHasImg(el: Element): boolean {
  for (const node of nodesInDocumentOrder(el)) {
    if (node.type === "tag" && node.tagName.toLowerCase() === "img") {
      return true;
    }
  }
  return false;
}

type FigureCaptionEv = { t: "img"; el: Element } | { t: "cap"; text: string };

/**
 * Порядок событий совпадает с порядком обхода изображений в buildSectionTextAndImages.
 * Подпись «Рис. …» в отдельном блоке относится только к последнему img перед ней.
 */
function collectFigureCaptionEvents($: cheerio.CheerioAPI, siblings: Element[]): FigureCaptionEv[] {
  const events: FigureCaptionEv[] = [];

  function emitImgsFromFragmentRoot(fragmentRoot: Element, blockEl: Element) {
    for (const node of nodesInDocumentOrder(fragmentRoot)) {
      if (node.type !== "tag" || node.tagName.toLowerCase() !== "img") continue;
      events.push({ t: "img", el: node });
      const after = normalizeCaptionText(textAfterImgInBlock(blockEl, node));
      if (after && isFigureCaption(after)) {
        events.push({ t: "cap", text: after });
      }
    }
  }

  function maybeEmitStandaloneCaptionBlock(blockEl: Element) {
    if (blockSubtreeHasImg(blockEl)) return;
    const cap = firstFigureCaptionInSiblingEl($, blockEl);
    if (cap) events.push({ t: "cap", text: cap });
  }

  for (let si = 0; si < siblings.length; si += 1) {
    const el = siblings[si];
    const tag = el.tagName.toLowerCase();

    if (tag === "ul" || tag === "ol") {
      for (const li of $(el).find("li").toArray()) {
        if (li.type !== "tag") continue;
        emitImgsFromFragmentRoot(li, el);
        maybeEmitStandaloneCaptionBlock(li);
      }
      continue;
    }

    if (tag === "table") {
      for (const tr of $(el).find("tr").toArray()) {
        if (tr.type !== "tag") continue;
        emitImgsFromFragmentRoot(tr, el);
        maybeEmitStandaloneCaptionBlock(tr);
      }
      continue;
    }

    if (tag === "img") {
      events.push({ t: "img", el });
      continue;
    }

    emitImgsFromFragmentRoot(el, el);
    maybeEmitStandaloneCaptionBlock(el);
  }

  return events;
}

/** Сопоставление: подпись после группы img — только последнему; подпись до первого img — очередь orphan. */
function figureCaptionByImgFromEvents(events: FigureCaptionEv[]): Map<Element, string> {
  const map = new Map<Element, string>();
  const pending: Element[] = [];
  const orphanCaps: string[] = [];

  for (const ev of events) {
    if (ev.t === "img") {
      if (orphanCaps.length > 0) {
        map.set(ev.el, orphanCaps.shift()!);
      } else {
        pending.push(ev.el);
      }
    } else {
      if (pending.length > 0) {
        const target = pending[pending.length - 1];
        map.set(target, ev.text);
        pending.length = 0;
      } else {
        orphanCaps.push(ev.text);
      }
    }
  }

  return map;
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
      if (t) parts.push(t);
    }
  }
  return parts.join(" ").replace(/[ \t]+/g, " ").trim();
}

function wrapImageDescriptionInSectionText(
  description: string,
  type: ImageLlmType,
  relPath: string,
  llmname: string
): string {
  const d = description.trim();
  if (!d) return "";

  if (type === "icon") return `${iconDescriptionStartWithPath(relPath, llmname)}${d}${ICON_DESCRIPTION_END}`;

  return `${imageDescriptionStartWithPath(relPath)}${d}${IMAGE_DESCRIPTION_END}`;
}

async function handleDataImage(
  $: cheerio.CheerioAPI,
  imgEl: Element,
  captionByImg: ReadonlyMap<Element, string>,
  sectionIndex: number,
  mediaFiles: Map<string, Buffer>,
  images: OutlineSectionImage[],
  imgCounter: { n: number }
): Promise<string> {
  const src = $(imgEl).attr("src");
  if (!src?.startsWith("data:")) return "";

  const parsed = parseDataUrl(src);
  if (!parsed || parsed.buffer.length === 0) return "";

  const idx = imgCounter.n;
  const ext = mimeToExtension(parsed.contentType);
  const relPathImg = `img/s${sectionIndex}-i${idx}.${ext}`;
  const relPathIcon = `icon/s${sectionIndex}-i${idx}.${ext}`;
  imgCounter.n += 1;

  let name = "";
  const cap = captionByImg.get(imgEl);
  if (cap) name = cap;
  
  const llm = await fetchImageMetadataFromLlm(parsed.buffer, parsed.contentType);
  if (llm.type === 'icon') name = llm.llmname;

  if (!name || name.trim() === '') name = llm.llmname;
  if (llm.type === 'pict') mediaFiles.set(relPathImg, parsed.buffer);
  if (llm.type === 'icon') mediaFiles.set(relPathIcon, parsed.buffer);

  const relPath = llm.type === 'pict' ? relPathImg : relPathIcon;
  images.push({
    name: name,
    img: relPath,
    llmname: llm.llmname,
    description: llm.description,
    type: llm.type,
  });

  return wrapImageDescriptionInSectionText(llm.description, llm.type, relPath, llm.llmname);
}

async function fragmentToTextWithImages(
  $: cheerio.CheerioAPI,
  fragmentRoot: Element,
  captionByImg: ReadonlyMap<Element, string>,
  sectionIndex: number,
  mediaFiles: Map<string, Buffer>,
  images: OutlineSectionImage[],
  imgCounter: { n: number }
): Promise<string> {
  let out = "";
  for (const node of nodesInDocumentOrder(fragmentRoot)) {
    if (node.type === "text") {
      out += node.data.replace(/\u00a0/g, " ");
      continue;
    }
    if (node.type === "tag" && node.tagName.toLowerCase() === "img") {
      out += await handleDataImage(
        $,
        node,
        captionByImg,
        sectionIndex,
        mediaFiles,
        images,
        imgCounter
      );
    }
  }
  return out.trim();
}

async function buildSectionTextAndImages(
  $: cheerio.CheerioAPI,
  sectionNodes: AnyNode[],
  sectionIndex: number,
  mediaFiles: Map<string, Buffer>
): Promise<{ text: string; images: OutlineSectionImage[] }> {
  const siblings = sectionNodes.filter((n): n is Element => n.type === "tag");
  const captionByImg = figureCaptionByImgFromEvents(collectFigureCaptionEvents($, siblings));
  const parts: string[] = [];
  const images: OutlineSectionImage[] = [];
  const imgCounter = { n: 0 };

  for (let si = 0; si < siblings.length; si += 1) {
    const el = siblings[si];
    const tag = el.tagName.toLowerCase();

    if (tag === "ul" || tag === "ol") {
      for (const li of $(el).find("li").toArray()) {
        if (li.type !== "tag") continue;

        const chunk = await fragmentToTextWithImages(
          $,
          li,
          captionByImg,
          sectionIndex,
          mediaFiles,
          images,
          imgCounter
        );
        if (chunk) {
          parts.push(chunk);
        }
      }
      continue;
    }

    if (tag === "table") {
      for (const tr of $(el).find("tr").toArray()) {
        if (tr.type !== "tag") {
          continue;
        }
        let chunk = await fragmentToTextWithImages(
          $,
          tr,
          captionByImg,
          sectionIndex,
          mediaFiles,
          images,
          imgCounter
        );
        chunk = chunk.replace(/\s+/g, " ").trim();
        if (chunk) {
          parts.push(chunk);
        }
      }
      continue;
    }

    if (tag === "img") {
      const chunk = await handleDataImage(
        $,
        el,
        captionByImg,
        sectionIndex,
        mediaFiles,
        images,
        imgCounter
      );
      if (chunk) {
        parts.push(chunk);
      }
      continue;
    }

    const chunk = await fragmentToTextWithImages(
      $,
      el,
      captionByImg,
      sectionIndex,
      mediaFiles,
      images,
      imgCounter
    );
    if (chunk) {
      parts.push(chunk);
    }
  }

  return {
    text: normalizeBlockText(parts.join("\n\n")),
    images,
  };
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
    const betweenNodes = $between.toArray();
    const sectionNodes =
      i === 0 ? [...preambleSiblings, ...betweenNodes] : betweenNodes;

    const { text: sectionText, images } = await buildSectionTextAndImages(
      $,
      sectionNodes,
      i,
      mediaFiles
    );
    const text = stripLeadingTitleDuplicate(sectionText, headingTitle);

    stack.push({ level, item: currentItem });

    const item: OutputItem = {
      number: currentItem.number,
      label: currentItem.label,
      title: headingTitle,
      text,
      parents,
    };

    if (images.length) item.images = images;
    
    output.push(item);
  }

  return { items: output, mediaFiles };
}
