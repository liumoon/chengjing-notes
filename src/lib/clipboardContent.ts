import type { AttachmentRecord } from "../types";
import type { SelectedAttachmentInput } from "./cardAttachments";
import { extractClipboardAttachments } from "./clipboardAttachments";
import { extractClipboardImages, clipboardImageKey } from "./clipboardImages";
import { attachmentRef } from "./attachmentRefs";
import { sanitizeImportHtml } from "./htmlSanitize";
import type { ClipboardImageInput } from "./clipboardImages";

/**
 * 剪貼簿的唯一分流點。
 *
 * 富文字、Markdown、日誌與白板都只問這裡：這次貼上的是文字、格式化內容、
 * 圖片、檔案，還是混合體。過去兩個編輯器各自判斷，結果是「貼文字跳出圖片」
 * 與「同一張圖貼兩次」，因為 Chromium 會把同一張圖用兩個不同的 Blob 物件
 * 分別放在 `items` 與 `files`，而只要有圖片就把整次貼上攔下來。
 */
export type ClipboardPasteKind = "empty" | "text" | "html" | "media" | "mixed" | "file";

export interface ClipboardPasteContent {
  kind: ClipboardPasteKind;
  /** `text/plain` 的原始內容，逐字保留，不重複 HTML 跳脫。 */
  text: string;
  /** `text/html` 的原始內容，未經清理；要插入前一律先過 `sanitizeImportHtml`。 */
  html: string;
  images: ClipboardImageInput[];
  files: SelectedAttachmentInput[];
}

const EMPTY: ClipboardPasteContent = { kind: "empty", text: "", html: "", images: [], files: [] };

function readClipboardText(data: DataTransfer | null, type: string) {
  try { return data?.getData?.(type) || ""; } catch { return ""; }
}

export function hasMeaningfulText(value: string) {
  return Boolean(String(value || "").trim());
}

export function classifyClipboardPaste(event: ClipboardEvent): ClipboardPasteContent {
  const data = event.clipboardData;
  if (!data) return EMPTY;
  const text = readClipboardText(data, "text/plain");
  const html = readClipboardText(data, "text/html");
  const files = extractClipboardAttachments(event);
  const images = extractClipboardImages(event);

  if (files.length && !images.length) return { kind: "file", text, html, images, files };
  if (images.length && !hasMeaningfulText(text)) return { kind: "media", text, html, images, files };
  if (images.length) return { kind: "mixed", text, html, images, files };
  if (hasMeaningfulText(html)) return { kind: "html", text, html, images, files };
  if (hasMeaningfulText(text)) return { kind: "text", text, html, images, files };
  return EMPTY;
}

/**
 * 同一次 `paste` 事件只准被處理一次。React 的 `onPaste` 與 ProseMirror 的
 * `handlePaste` 在某些 WebView 上會都觸發，沒有這道識別就會存出兩份附件。
 */
const claimed = new WeakSet<ClipboardEvent>();

export function claimClipboardPaste(event: ClipboardEvent) {
  if (claimed.has(event)) return false;
  claimed.add(event);
  return true;
}

/**
 * 混合貼上（文字＋內嵌圖片）時，把 HTML 裡的 `<img>` 依文件順序換成附件參考，
 * 順序、格式與圖片都保留，也不會再另外插入一張重複的圖。沒有對應位置的圖片
 * 附加在末尾，避免使用者貼进来的內容被靜默遺失。
 */
export function embedClipboardImagesInHtml(html: string, attachments: AttachmentRecord[]) {
  if (typeof DOMParser === "undefined") return { html: "", placed: 0, appended: 0 };
  const document = new DOMParser().parseFromString(html || "", "text/html");
  const pool = [...attachments];
  let cursor = 0;

  document.body.querySelectorAll("img").forEach((element) => {
    const attachment = pool[cursor];
    if (!attachment) return;
    cursor += 1;
    element.setAttribute("src", attachmentRef(attachment.id));
    element.setAttribute("data-attachment-id", attachment.id);
    if (!element.getAttribute("alt")) element.setAttribute("alt", attachment.name);
  });

  const placed = cursor;
  const appended = pool.length - placed;
  for (const attachment of pool.slice(placed)) {
    const paragraph = document.createElement("p");
    const image = document.createElement("img");
    image.setAttribute("src", attachmentRef(attachment.id));
    image.setAttribute("data-attachment-id", attachment.id);
    image.setAttribute("alt", attachment.name);
    paragraph.appendChild(image);
    document.body.appendChild(paragraph);
  }

  return {
    html: sanitizeImportHtml(document.body.innerHTML, { allowRemoteImages: false, allowDataImages: false }),
    placed,
    appended,
  };
}
