import { marked } from "marked";
import { sanitizeImportHtml } from "./htmlSanitize";
import { resolveInlineImageSrcs } from "./attachmentRefs";
import type { AttachmentRecord } from "../types";

/**
 * Markdown 即時預覽的純函式部分。
 *
 * 切成區塊、渲染區塊、把附件參考換成本機 URL，全部在這裡完成，
 * 讓 CodeMirror 的裝飾層只負責「哪一塊要顯示原始碼」。
 */
export interface MarkdownBlock {
  from: number;
  to: number;
  text: string;
}

/** 以空行切塊；圍欄程式碼區塊内部的空行不切。 */
export function markdownBlocks(source: string): MarkdownBlock[] {
  const text = String(source || "");
  if (!text.trim()) return [];
  const blocks: MarkdownBlock[] = [];
  let offset = 0;
  let start: number | null = null;
  let fence: string | null = null;

  const close = (end: number) => {
    if (start === null) return;
    const chunk = text.slice(start, end);
    if (chunk.trim()) blocks.push({ from: start, to: end, text: chunk });
    start = null;
  };

  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1].slice(0, 3);
      if (start === null) start = offset;
      if (fence === null) fence = marker;
      else if (line.trim().startsWith(fence)) fence = null;
      offset = lineEnd + 1;
      continue;
    }
    if (fence) {
      if (start === null) start = offset;
      offset = lineEnd + 1;
      continue;
    }
    if (!line.trim()) {
      close(offset);
      offset = lineEnd + 1;
      continue;
    }
    if (start === null) start = offset;
    offset = lineEnd + 1;
  }
  close(text.length);
  return blocks;
}

/** 區塊是否包含選取範圍（含游標貼在區塊開頭或結尾）。 */
export function blockContains(block: MarkdownBlock, from: number, to: number) {
  return to >= block.from && from <= block.to;
}

/**
 * Markdown 區塊 → 安全的預覽 HTML。
 *
 * 網路圖片不會直接載入，改成「下載」提示；`attachment://` 解析成本機 URL；
 * 附件遺失時保留佔位，不讓內容憑空消失。
 */
export function renderMarkdownBlock(source: string, attachments: AttachmentRecord[] = []): { html: string; remoteImages: string[] } {
  const text = String(source || "");
  if (!text.trim()) return { html: "", remoteImages: [] };
  let parsed = "";
  try {
    parsed = marked.parse(text, { async: false, gfm: true }) as string;
  } catch {
    return { html: "", remoteImages: [] };
  }
  const sanitized = sanitizeImportHtml(parsed, { allowRemoteImages: true, allowDataImages: true });
  if (typeof DOMParser === "undefined") return { html: sanitized, remoteImages: [] };

  const document = new DOMParser().parseFromString(sanitized, "text/html");
  const remoteImages: string[] = [];
  document.body.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    if (/^https?:\/\//i.test(src)) {
      remoteImages.push(src);
      const chip = document.createElement("span");
      chip.className = "md-remote-chip";
      chip.setAttribute("contenteditable", "false");
      chip.setAttribute("data-remote-url", src);
      chip.setAttribute("role", "button");
      chip.setAttribute("tabindex", "0");
      chip.textContent = src;
      image.replaceWith(chip);
    }
  });
  const resolved = resolveInlineImageSrcs(document.body.innerHTML, attachments);
  return { html: resolved.html, remoteImages };
}

/**
 * 把預覽 DOM 裡的文字偏移換回原始碼偏移。
 *
 * 點預覽時游標要落在附近，而不是整塊開頭；這裡跳過 Markdown 標記，
 * 只數「看得到的字」，因此對粗體、連結與行內程式碼都夠用。
 */
export function previewOffsetToSource(source: string, textOffset: number) {
  const text = String(source || "");
  const target = Math.max(0, textOffset);
  const newline = String.fromCharCode(10);
  const backslash = String.fromCharCode(92);
  let counted = 0;
  let index = 0;
  let inFence = false;
  let atLineStart = true;
  while (index < text.length) {
    if (!inFence && text.startsWith("```", index)) {
      inFence = !inFence;
      index += 3;
      atLineStart = false;
      continue;
    }
    if (inFence) {
      atLineStart = text[index] === newline;
      counted += 1;
      index += 1;
      continue;
    }
    if (atLineStart) {
      const marker = text.slice(index).match(/^( {0,3})(#{1,6} +|> ?|[-*+] +|[0-9]+[.)] +)/);
      if (marker) {
        index += marker[0].length;
        atLineStart = false;
        continue;
      }
      atLineStart = false;
    }
    const char = text[index];
    if (char === newline) {
      atLineStart = true;
      counted += 1;
      index += 1;
      continue;
    }
    if (char === backslash && index + 1 < text.length) {
      counted += 1;
      index += 2;
      continue;
    }
    const emphasis = text.slice(index).match(/^[*_~]{1,3}/);
    if (emphasis) {
      index += emphasis[0].length;
      continue;
    }
    const backtick = text.slice(index).match(/^`+/);
    if (backtick) {
      index += backtick[0].length;
      continue;
    }
    if (char === "[" || (char === "!" && text[index + 1] === "[")) {
      const open = text.indexOf("[", index);
      const close = open < 0 ? -1 : text.indexOf("]", open);
      const end = close < 0 ? -1 : text.indexOf(")", close);
      if (open >= 0 && close > open && end > close) {
        const label = text.slice(open + 1, close);
        if (counted + label.length >= target) return open + 1 + Math.max(0, target - counted);
        counted += label.length;
        index = end + 1;
        continue;
      }
    }
    if (counted >= target) return index;
    counted += 1;
    index += 1;
  }
  return text.length;
}
