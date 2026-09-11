import { documentToHtml, htmlToMarkdown, markdownToDocument, normalizeHtml, stripBom } from "./markdownBridge";
import { reconcileTaskIds } from "./markdownTasks";
import { findRemoteImages, sanitizeImportHtml } from "./htmlSanitize";
import { canonicalizeImageSrcs } from "./attachmentRefs";
import type { AttachmentRecord, CardRecord } from "../types";

/**
 * 澄境卡片內容的唯一管線。
 *
 * RichEditor、日誌、AI 動作、MCP、白板與匯入器一律透過這裡產生
 * `contentHtml` 與 `plainText`，不再各自拼 HTML。`contentHtml` 仍是卡片
 * 唯一內容欄位，Markdown 只是同一份文件的可編輯投影。
 */
export interface ContentChunk {
  contentHtml: string;
  plainText: string;
  warnings: string[];
  /** 尚未取得同意、已改成文字占位的網路圖片網址。 */
  remoteImages: string[];
  engine: "tiptap" | "fallback";
}

const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "TR", "DIV", "FIGURE", "HR"]);

/**
 * 與 TipTap `getText({ blockSeparator: "\n" })` 對齊的純文字投影。
 * 富文字與 Markdown 兩條路徑共用同一函式，切換模式不會讓 plainText 漂移。
 */
export function plainTextFromHtml(html: string) {
  const document = new DOMParser().parseFromString(html || "", "text/html");
  document.body.querySelectorAll('ul[data-type="taskList"] label, ul[data-type="taskList"] input').forEach((element) => element.remove());
  const lines: string[] = [];
  const flush = (buffer: string[]) => {
    const text = buffer.join("").replace(/[ \t\u00a0]+/g, " ").trim();
    if (text) lines.push(text);
    buffer.length = 0;
  };
  const walk = (node: Node, buffer: string[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer.push(node.textContent || "");
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      buffer.push(" ");
      return;
    }
    const isBlock = BLOCK_TAGS.has(node.tagName);
    if (isBlock) flush(buffer);
    node.childNodes.forEach((child) => walk(child, buffer));
    if (isBlock) flush(buffer);
  };
  const buffer: string[] = [];
  [...document.body.childNodes].forEach((child) => walk(child, buffer));
  flush(buffer);
  return lines.join("\n").trim();
}

function chunk(contentHtml: string, extra: Partial<ContentChunk> = {}): ContentChunk {
  const html = contentHtml || "<p></p>";
  const base: ContentChunk = { contentHtml: html, plainText: plainTextFromHtml(html), warnings: [], remoteImages: [], engine: "tiptap" };
  return { ...base, ...extra, contentHtml: html };
}

function warnings(...values: Array<string | undefined>) {
  return values.filter(Boolean) as string[];
}

/** Markdown → 卡片內容；`previousHtml` 用於復用核取清單 ID。 */
export async function fromMarkdown(markdown: string, options: { previousHtml?: string; allowRemoteImages?: boolean } = {}): Promise<ContentChunk> {
  const text = stripBom(markdown);
  if (!text.trim()) return chunk("<p></p>");
  const parsed = await markdownToDocument(text);
  const rendered = parsed.value?.content?.length ? await documentToHtml(parsed.value) : { value: "", engine: parsed.engine };
  if (!rendered.value) return { ...fromPlainText(text), warnings: warnings("markdown-engine-fallback") };
  const remoteImages = options.allowRemoteImages ? [] : findRemoteImages(rendered.value);
  const sanitized = sanitizeImportHtml(rendered.value, { allowRemoteImages: options.allowRemoteImages === true });
  const reconciled = reconcileTaskIds(sanitized, options.previousHtml || "");
  const normalized = await normalizeHtml(reconciled.html);
  return chunk(normalized.value, {
    warnings: warnings(parsed.warning, rendered.warning, normalized.warning, reconciled.created ? `tasks-recreated:${reconciled.created}` : undefined),
    remoteImages,
    engine: parsed.engine,
  });
}

/** HTML → 卡片內容；危險標籤與未授權的網路圖片在這裡就被擋下。 */
export async function fromHtml(html: string, options: { allowRemoteImages?: boolean; previousHtml?: string } = {}): Promise<ContentChunk> {
  const allowRemoteImages = options.allowRemoteImages === true;
  const remoteImages = allowRemoteImages ? [] : findRemoteImages(html || "");
  const sanitized = sanitizeImportHtml(html || "", { allowRemoteImages });
  const normalized = await normalizeHtml(sanitized);
  const reconciled = reconcileTaskIds(normalized.value, options.previousHtml || "");
  return chunk(reconciled.html, { warnings: warnings(normalized.warning), remoteImages, engine: normalized.engine });
}

/** 純文字 → 卡片內容；保留段落與換行，不將內容誤解成 Markdown。 */
export function fromPlainText(text: string): ContentChunk {
  const value = stripBom(text);
  if (!value.trim()) return chunk("<p></p>");
  const escape = (input: string) => input.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character] || character);
  const contentHtml = value
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("") || "<p></p>";
  return { contentHtml, plainText: value.trim(), warnings: [], remoteImages: [], engine: "tiptap" };
}

/** 卡片內容 → Markdown（語意保真，非位元級保真）。 */
export async function toMarkdown(contentHtml: string) {
  const result = await htmlToMarkdown(contentHtml || "<p></p>");
  return { markdown: result.value, engine: result.engine, warning: result.warning };
}

/** 把新內容附加到既有卡片尾部，維持核取清單 ID。 */
export async function appendContent(card: Pick<CardRecord, "contentHtml" | "plainText">, source: { contentHtml?: string; markdown?: string }) {
  const incomingHtml = source.markdown !== undefined ? (await fromMarkdown(source.markdown, { previousHtml: card.contentHtml })).contentHtml : source.contentHtml || "";
  if (!incomingHtml.trim()) return { contentHtml: card.contentHtml || "<p></p>", plainText: card.plainText || "" };
  const document = new DOMParser().parseFromString(card.contentHtml || "<p></p>", "text/html");
  const incoming = new DOMParser().parseFromString(incomingHtml, "text/html");
  document.body.querySelectorAll("p:only-child:empty").forEach((element) => element.remove());
  [...incoming.body.childNodes].forEach((node) => document.body.appendChild(node.cloneNode(true)));
  const reconciled = reconcileTaskIds(document.body.innerHTML, card.contentHtml || "");
  const normalized = await normalizeHtml(reconciled.html);
  const contentHtml = normalized.value || "<p></p>";
  return { contentHtml, plainText: plainTextFromHtml(contentHtml) };
}

/** 存庫前的最後一道防線：把畫面 URL 收回 `attachment://` 內部表示。 */
export function canonicalizeForStorage(contentHtml: string, attachments: AttachmentRecord[]) {
  const html = canonicalizeImageSrcs(contentHtml || "", attachments || []);
  return { contentHtml: html || "<p></p>", plainText: plainTextFromHtml(html) };
}
