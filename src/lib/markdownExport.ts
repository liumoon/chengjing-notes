import JSZip from "jszip";
import { db } from "../db";
import type { AppLanguage, AttachmentRecord, CardRecord } from "../types";
import { toMarkdown } from "./contentPipeline";
import { EXPORT_ASSETS_FOLDER, rewriteRefsForExport, safeAssetName } from "./attachmentRefs";
import { portableAttachmentBlob } from "./attachments";
import { uniqueArchiveName } from "./backupValidation";
import { getImportCopy } from "./importCopy";

/**
 * Markdown 匯出。
 *
 * 一律走 `contentPipeline.toMarkdown()`（真正的 TipTap serializer），
 * 不再用 `plainText` 頂替，因此標題、清單、核取清單、表格與程式碼
 * 都會留在輸出裡。附件改寫成 `assets/…` 相對路徑。
 */
export interface MarkdownExportDocument {
  filename: string;
  markdown: string;
  assets: Array<{ path: string; attachment: AttachmentRecord }>;
}

function frontMatter(card: CardRecord) {
  return [
    "---",
    `id: ${card.id}`,
    `type: ${card.kind}`,
    `created: ${new Date(card.createdAt).toISOString()}`,
    `updated: ${new Date(card.updatedAt).toISOString()}`,
    `tags: [${card.tagIds.join(", ")}]`,
    "---",
    "",
  ].join("\n");
}

export async function buildCardMarkdown(card: CardRecord, attachments: AttachmentRecord[]): Promise<MarkdownExportDocument> {
  const serialized = await toMarkdown(card.contentHtml || "<p></p>");
  const body = serialized.markdown.trim() || card.plainText || "";
  const inline = attachments.filter((attachment) => attachment.role === "inline");
  const markdown = `${frontMatter(card)}# ${card.title}\n\n${rewriteRefsForExport(body, inline)}\n`;
  return {
    filename: `${safeAssetName(card.title || card.id)}.md`,
    markdown,
    assets: inline.map((attachment) => ({ path: `${EXPORT_ASSETS_FOLDER}/${safeAssetName(attachment.name)}`, attachment })),
  };
}

/** 組出含 `assets/` 的 ZIP；沒有內嵌圖片時呼叫端應直接輸出 `.md`。 */
export async function buildMarkdownZip(documents: MarkdownExportDocument[]) {
  const zip = new JSZip();
  const used = new Set<string>();
  for (const document of documents) {
    zip.file(`${uniqueArchiveName(document.filename.replace(/\.md$/, ""), used)}.md`, document.markdown);
    for (const asset of document.assets) {
      const assetFolder = `${document.filename.replace(/\.md$/, "")}-${EXPORT_ASSETS_FOLDER}`;
      zip.file(`${assetFolder}/${safeAssetName(asset.attachment.name)}`, await portableAttachmentBlob(asset.attachment));
    }
  }
  return zip;
}

function saveBlob(blob: Blob, name: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** 單一卡片匯出 Markdown：無圖片 → `.md`，有圖片 → 含 `assets/` 的 ZIP。 */
export async function exportCardMarkdown(card: CardRecord, language: AppLanguage = "zh-TW") {
  const copy = getImportCopy(language);
  const attachments = (await Promise.all((card.attachmentIds || []).map((id) => db.attachments.get(id)))).filter(Boolean) as AttachmentRecord[];
  const document = await buildCardMarkdown(card, attachments);
  const name = document.assets.length ? `${document.filename.replace(/\.md$/, "")}.zip` : document.filename;
  if (document.assets.length) {
    const zip = new JSZip();
    zip.file(document.filename, document.markdown);
    const folder = `${document.filename.replace(/\.md$/, "")}-${EXPORT_ASSETS_FOLDER}`;
    for (const asset of document.assets) zip.file(`${folder}/${safeAssetName(asset.attachment.name)}`, await portableAttachmentBlob(asset.attachment));
    if (window.chengjing) {
      const result = await window.chengjing.files.save({
        title: copy.exportMarkdown,
        defaultPath: name,
        filters: [{ name: copy.exportZip, extensions: ["zip"] }],
        data: await zip.generateAsync({ type: "base64", compression: "DEFLATE" }),
        encoding: "base64",
      });
      return { canceled: result.canceled, name, withAssets: true };
    }
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    saveBlob(new Blob([buffer], { type: "application/zip" }), name);
    return { canceled: false, name, withAssets: true };
  }
  if (window.chengjing) {
    const result = await window.chengjing.files.save({ title: copy.exportMarkdown, defaultPath: name, filters: [{ name: "Markdown", extensions: ["md"] }], data: document.markdown });
    return { canceled: result.canceled, name, withAssets: false };
  }
  saveBlob(new Blob([document.markdown], { type: "text/markdown" }), name);
  return { canceled: false, name, withAssets: false };
}
