import { inferAttachmentMime } from "./attachments";
import type { SelectedAttachmentInput } from "./cardAttachments";
import { isSupportedClipboardImageMime } from "./clipboardImages";

function clipboardFilePath(file: Blob) {
  const candidate = (file as Blob & { path?: unknown }).path;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function fileName(file: Blob, path?: string) {
  const candidate = "name" in file ? String((file as File).name || "").trim() : "";
  if (candidate) return candidate;
  const pathName = path?.split(/[\\/]/).pop()?.trim();
  return pathName || "pasted-file";
}

function isImageFile(file: Blob, name: string) {
  const mime = inferAttachmentMime(name, file.type);
  return isSupportedClipboardImageMime(mime);
}

/**
 * Extract files copied from Finder, Explorer, or a native file picker.
 * Image blobs without a native path remain handled by the inline-image
 * paste flow, so screenshots keep their existing behavior.
 */
export function extractClipboardAttachments(event: ClipboardEvent): SelectedAttachmentInput[] {
  const data = event.clipboardData;
  const inputs: SelectedAttachmentInput[] = [];
  const seen = new Set<string>();

  const add = (file: Blob | null) => {
    if (!file) return;
    const path = clipboardFilePath(file);
    const name = fileName(file, path);
    if (!path && isImageFile(file, name)) return;

    const lastModified = "lastModified" in file ? String((file as File).lastModified || "") : "";
    const key = path || `${name}:${file.size}:${file.type}:${lastModified}`;
    if (seen.has(key)) return;
    seen.add(key);
    inputs.push({ name, path, blob: file });
  };

  Array.from(data?.files || []).forEach((file) => add(file));
  // Some Electron/WebView clipboard implementations expose files only via
  // DataTransferItem.getAsFile().
  Array.from(data?.items || []).forEach((item) => {
    if (item.kind === "file") add(item.getAsFile());
  });

  return inputs;
}
