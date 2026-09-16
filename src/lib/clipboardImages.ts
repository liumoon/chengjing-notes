import { appendCardAttachmentsWithHistory, db } from "../db";
import type { AttachmentRecord } from "../types";
import { attachmentRef, safeAssetName } from "./attachmentRefs";
import { persistAttachment, removeStoredAttachment } from "./attachments";
import { IMPORT_LIMITS } from "./importLimits";
import { imageDataUrlToBlob, sanitizeSvg } from "./svgSanitize";

export interface ClipboardImageInput {
  blob: Blob;
  name?: string;
  mime?: string;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

const EXTENSION_MIMES: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXTENSIONS).map(([mime, extension]) => [extension, mime === "image/jpg" ? "image/jpeg" : mime]),
);

function normalizeClipboardMime(mime: string, name = "") {
  const normalized = String(mime || "").trim().toLowerCase();
  if (isSupportedClipboardImageMime(normalized)) return normalized === "image/jpg" ? "image/jpeg" : normalized;
  const extension = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] || "";
  return EXTENSION_MIMES[extension] || "";
}

export function isSupportedClipboardImageMime(mime: string) {
  return Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, String(mime || "").trim().toLowerCase());
}

function blobName(blob: Blob) {
  return "name" in blob ? String((blob as File).name || "") : "";
}

export function dataImageInput(src: string, alt = ""): ClipboardImageInput | null {
  const mime = normalizeClipboardMime(String(src || "").match(/^data:([^;,]+)/i)?.[1] || "", "");
  if (!mime) return null;
  const blob = imageDataUrlToBlob(src);
  if (!blob) return null;
  const limit = mime === "image/svg+xml" ? IMPORT_LIMITS.svgBytes : IMPORT_LIMITS.mediaBytes;
  if (blob.size > limit) return null;
  return { blob, name: String(alt || "").trim(), mime };
}

/** WebView 與部分瀏覽器只把圖片放在 text/html 的 data URL 裡。 */
export function extractDataImagesFromHtml(html: string) {
  if (!html || typeof DOMParser === "undefined") return [] as ClipboardImageInput[];
  const document = new DOMParser().parseFromString(html, "text/html");
  const images: ClipboardImageInput[] = [];
  const seen = new Set<string>();
  document.body.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    if (seen.has(src)) return;
    const input = dataImageInput(src, image.getAttribute("alt") || image.getAttribute("title") || "");
    if (!input) return;
    seen.add(src);
    images.push(input);
  });
  return images;
}

/**
 * Chromium exposes the same clipboard image as two *different* Blob objects,
 * one through `items` and one through `files`, so identity-based dedupe lets
 * a single screenshot through twice. `items` is the primary source, `files`
 * only fills the gap, and the dedupe key is the shape of the payload.
 */
export function extractClipboardImages(event: ClipboardEvent): ClipboardImageInput[] {
  const data = event.clipboardData;
  const images: ClipboardImageInput[] = [];
  const seen = new Set<string>();
  const add = (blob: Blob | null, declaredMime = "") => {
    if (!blob) return;
    const nativePath = "path" in blob ? (blob as File & { path?: unknown }).path : undefined;
    // A file copied from Finder/Explorer is a regular attachment, even when
    // its MIME is an image. Screenshots without a native path remain inline.
    if (typeof nativePath === "string" && nativePath.trim()) return;
    const mime = normalizeClipboardMime(declaredMime || blob.type, blobName(blob));
    if (!isSupportedClipboardImageMime(mime)) return;
    const key = clipboardImageKey(blob, mime);
    if (seen.has(key)) return;
    seen.add(key);
    images.push({ blob, name: blobName(blob), mime });
  };
  const itemFiles: Array<{ blob: Blob | null; mime: string }> = [];
  Array.from(data?.items || []).forEach((item) => {
    if (item.kind === "file") itemFiles.push({ blob: item.getAsFile(), mime: item.type });
  });
  itemFiles.forEach((entry) => add(entry.blob, entry.mime));
  // Some WebViews expose clipboard images through files but not items.
  if (!itemFiles.length) Array.from(data?.files || []).forEach((file) => add(file));
  // Android WebViews and some browser integrations expose copied screenshots
  // as an HTML data URL instead of a file clipboard item.
  if (!images.length) {
    let html = "";
    try { html = data?.getData?.("text/html") || ""; } catch { /* clipboard access can be denied */ }
    // 保留 `<img alt>` 當檔名：`add()` 會從 Blob 重新推檔名，那樣就只剩 image.png。
    extractDataImagesFromHtml(html).forEach((image) => {
      const key = clipboardImageKey(image.blob, image.mime);
      if (seen.has(key)) return;
      seen.add(key);
      images.push(image);
    });
  }
  return images;
}

export function clipboardImageKey(blob: Blob, mime = "") {
  const normalized = normalizeClipboardMime(mime || blob.type, blobName(blob));
  return `${normalized || "unknown"}:${blob.size}:${blobName(blob)}`;
}

function imageExtension(mime: string) {
  return MIME_EXTENSIONS[String(mime || "").toLowerCase()] || "png";
}

export function clipboardImageFileName(input: ClipboardImageInput, index = 0, now = Date.now()) {
  const mime = String(input.mime || input.blob.type || "").toLowerCase();
  const extension = imageExtension(mime);
  const rawName = String(input.name || "").trim();
  const source = rawName ? safeAssetName(rawName) : "";
  if (source && /\.[a-z0-9]{1,8}$/i.test(source)) return source;
  if (source) return `${source}.${extension}`;
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `pasted-image-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}${suffix}.${extension}`;
}

export async function persistClipboardImages(inputs: ClipboardImageInput[]): Promise<AttachmentRecord[]> {
  if (!inputs.length) return [];
  const normalized = inputs.map((input) => {
    const mime = normalizeClipboardMime(input.mime || input.blob.type, blobName(input.blob) || input.name || "");
    return { ...input, mime };
  });
  if (normalized.some((input) => !isSupportedClipboardImageMime(input.mime))) {
    throw new Error("clipboard-image-unsupported");
  }
  if (normalized.some((input) => {
    const limit = input.mime === "image/svg+xml" ? IMPORT_LIMITS.svgBytes : IMPORT_LIMITS.mediaBytes;
    return !Number.isFinite(input.blob.size) || input.blob.size > limit;
  })) {
    throw new Error("clipboard-image-too-large");
  }

  const created: AttachmentRecord[] = [];
  const fingerprints = new Set<string>();
  try {
    const batch: typeof normalized = [];
    for (const input of normalized) {
      const key = await clipboardBlobFingerprint(input);
      if (fingerprints.has(key)) continue;
      fingerprints.add(key);
      batch.push(input);
    }
    for (const [index, input] of batch.entries()) {
      let blob = input.blob.type === input.mime ? input.blob : input.blob.slice(0, input.blob.size, input.mime);
      if (input.mime === "image/svg+xml") {
        const sanitized = sanitizeSvg(await blob.text());
        if (!sanitized) throw new Error("clipboard-svg-rejected");
        blob = new Blob([sanitized.svg], { type: "image/svg+xml" });
      }
      created.push(await persistAttachment(clipboardImageFileName(input, index), blob, input.mime, undefined, "inline"));
    }
    return created;
  } catch (error) {
    await Promise.all(created.map((attachment) => removeStoredAttachment(attachment).catch(() => {})));
    throw error;
  }
}

/** Same bytes pasted twice in one event must not become two attachments. */
export async function clipboardBlobFingerprint(input: ClipboardImageInput) {
  const head = new Uint8Array(await input.blob.slice(0, 64).arrayBuffer());
  const tail = new Uint8Array(await input.blob.slice(-64).arrayBuffer());
  let hash = 2166136261;
  for (const byte of head) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  for (const byte of tail) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `${input.mime || input.blob.type}:${input.blob.size}:${hash.toString(16)}`;
}

export async function removeClipboardImages(attachments: AttachmentRecord[]) {
  await Promise.all(attachments.map((attachment) => removeStoredAttachment(attachment).catch(() => {})));
}

/**
 * Undo the card registration when an editor cannot insert the saved images.
 * The attachment row is deleted only after checking that another card does
 * not reference it, so a late concurrent update cannot remove shared data.
 */
export async function rollbackInlineClipboardImages(cardId: string, attachments: AttachmentRecord[]) {
  const records = [...new Map(attachments.filter((attachment) => attachment.id).map((attachment) => [attachment.id, attachment])).values()];
  const ids = records.map((attachment) => attachment.id);
  if (!ids.length) return;
  const idSet = new Set(ids);
  const removable: AttachmentRecord[] = [];
  await db.transaction("rw", [db.cards, db.attachments], async () => {
    const card = await db.cards.get(cardId);
    if (card) {
      const nextAttachmentIds = card.attachmentIds.filter((id) => !idSet.has(id));
      if (nextAttachmentIds.length !== card.attachmentIds.length) {
        await db.cards.update(cardId, { attachmentIds: nextAttachmentIds, updatedAt: Date.now() });
      }
    }
    for (const attachment of records) {
      const stillReferenced = await db.cards.filter((item) => item.attachmentIds.includes(attachment.id)).count();
      if (!stillReferenced) {
        await db.attachments.delete(attachment.id);
        removable.push(attachment);
      }
    }
  });
  await Promise.all(removable.map((attachment) => {
    if (typeof window !== "undefined" && attachment.storage === "file" && attachment.relativePath && window.chengjing?.attachments?.remove) {
      return window.chengjing?.attachments?.remove(attachment.relativePath).catch(() => {});
    }
    return undefined;
  }));
}

/**
 * Persist the image files and register them on the card before the editor
 * inserts their references. This prevents a saved `attachment://` node from
 * briefly pointing at an attachment that is not part of the card record.
 */
export async function persistInlineClipboardImages(cardId: string, inputs: ClipboardImageInput[]) {
  if (!inputs.length) return [];
  const created = await persistClipboardImages(inputs);
  try {
    const updated = await appendCardAttachmentsWithHistory(cardId, created.map((attachment) => attachment.id));
    if (!updated) throw new Error("card-not-found");
    return created;
  } catch (error) {
    await removeClipboardImages(created);
    throw error;
  }
}

export function clipboardMarkdownForAttachments(attachments: AttachmentRecord[]) {
  return attachments.map((attachment) => `![${attachment.name}](${attachmentRef(attachment.id)})`).join("\n\n");
}
