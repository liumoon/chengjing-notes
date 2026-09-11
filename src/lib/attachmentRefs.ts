import type { AttachmentRecord } from "../types";
import { attachmentUrl } from "./attachments";

/**
 * 卡片正文內部一律用 `attachment://<id>` 指向附件。
 *
 * 富文字畫面把它解析成桌面 `chengjing-attachment://` 或 Android
 * `https://appassets.androidplatform.net/…` 的本機 URL；匯出 Markdown 時
 * 再改寫成 `assets/<id>-<name>` 的相對路徑。這樣卡片內容、同步協定與
 * 備份裡永遠只有一份穩定識別，不會把裝置路徑寫進資料。
 */
export const ATTACHMENT_SCHEME = "attachment://";
export const EXPORT_ASSETS_FOLDER = "assets";

export function attachmentRef(attachmentId: string) {
  return `${ATTACHMENT_SCHEME}${attachmentId}`;
}

export function isAttachmentRef(value: string) {
  return String(value || "").startsWith(ATTACHMENT_SCHEME);
}

export function attachmentIdFromRef(value: string) {
  return isAttachmentRef(value) ? decodeURIComponent(value.slice(ATTACHMENT_SCHEME.length)) : "";
}

export function safeAssetName(name: string) {
  const cleaned = String(name || "attachment")
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "attachment").slice(0, 160);
}

/** 與 `backup.ts` 全庫匯出的附件檔名規則保持一致。 */
export function exportAssetPath(attachment: Pick<AttachmentRecord, "id" | "name">) {
  return `${EXPORT_ASSETS_FOLDER}/${safeAssetName(attachment.name)}`;
}

/** 富文字畫面：把正文中的 `attachment://` 換成本機可顯示的 URL。 */
export function resolveInlineImageSrcs(html: string, attachments: AttachmentRecord[]) {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const created: string[] = [];
  const document = new DOMParser().parseFromString(html || "", "text/html");
  document.body.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    if (!isAttachmentRef(src)) return;
    const attachment = byId.get(attachmentIdFromRef(src));
    const url = attachment ? attachmentUrl(attachment) : "";
    if (url) {
      image.setAttribute("src", url);
      if (attachment && attachment.storage !== "file" && attachment.blob) created.push(url);
      image.setAttribute("data-attachment-id", attachment?.id || "");
    } else {
      // 附件已被移除時保留可讀的占位，不留破圖。
      image.setAttribute("data-missing-attachment", attachmentIdFromRef(src));
      image.setAttribute("src", "");
    }
  });
  return { html: document.body.innerHTML, resolved: created };
}

export function releaseResolvedUrls(urls: string[]) {
  for (const url of urls) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

/** 富文字畫面 → 存庫：把本機 URL 還原成 `attachment://` 內部表示。 */
export function canonicalizeImageSrcs(html: string, attachments: AttachmentRecord[]) {
  const byPath = new Map<string, string>();
  for (const attachment of attachments) {
    if (attachment.relativePath) byPath.set(attachment.relativePath, attachment.id);
  }
  const document = new DOMParser().parseFromString(html || "", "text/html");
  document.body.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    if (isAttachmentRef(src)) return;
    const declared = image.getAttribute("data-attachment-id") || "";
    if (declared && byPath.size >= 0) {
      image.setAttribute("src", attachmentRef(declared));
      return;
    }
    for (const [relativePath, id] of byPath) {
      if (src.includes(encodeURIComponent(relativePath)) || src.endsWith(relativePath)) {
        image.setAttribute("src", attachmentRef(id));
        return;
      }
    }
    if (/^(blob:|chengjing-attachment:)/i.test(src)) image.setAttribute("src", "");
  });
  return document.body.innerHTML;
}

/** 匯出：Markdown 與 HTML 中的附件引用改寫為 `assets/…` 相對路徑。 */
export function rewriteRefsForExport(value: string, attachments: AttachmentRecord[]) {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return String(value || "").replace(/attachment:\/\/([A-Za-z0-9_-]+)/g, (match, id: string) => {
    const attachment = byId.get(id);
    return attachment ? exportAssetPath(attachment) : match;
  });
}

/** 匯入：把相對路徑或本機 URL 改寫成 `attachment://<id>`。 */
export function rewriteRefsForImport(value: string, mapping: Array<{ match: string; attachmentId: string }>) {
  let output = String(value || "");
  for (const entry of mapping) {
    if (!entry.match) continue;
    output = output.split(entry.match).join(attachmentRef(entry.attachmentId));
  }
  return output;
}

/** 正文目前引用了哪些附件 ID（刪除正文圖片時用來判斷是否需要清理）。 */
export function referencedAttachmentIds(html: string) {
  const document = new DOMParser().parseFromString(html || "", "text/html");
  const ids = new Set<string>();
  document.body.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    if (isAttachmentRef(src)) ids.add(attachmentIdFromRef(src));
    const declared = image.getAttribute("data-attachment-id") || "";
    if (declared) ids.add(declared);
  });
  return [...ids];
}

export function inlineImageMarkdown(alt: string, attachmentId: string) {
  return `![${alt || ""}](${attachmentRef(attachmentId)})`;
}
