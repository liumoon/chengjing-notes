import { createCard } from "../db";
import type { AppLanguage, AttachmentRecord, CardKind, CardRecord } from "../types";
import { fromHtml, fromMarkdown, fromPlainText, plainTextFromHtml } from "./contentPipeline";
import { attachmentRef, safeAssetName } from "./attachmentRefs";
import { findRemoteImages, sanitizeImportHtml } from "./htmlSanitize";
import { downloadRemoteAssets, resolveLocalAssets } from "./documentBridge";
import { checkSizeLimit, classifyDocument, IMPORT_LIMITS, type ImportFileKind } from "./importLimits";
import { getImportCopy, importWarningCopy } from "./importCopy";
import { dataUrlToBlob } from "./utils";
import { inferAttachmentMime, persistAttachment, removeStoredAttachment } from "./attachments";

/**
 * 一檔一卡的匯入交易。
 *
 * 每個檔案都是獨立交易：解析或保存失敗時，只回收「這個檔案」建立的來源
 * 與內嵌附件，不回滾同批已成功的其他文件，因此批次匯入可以部分成功，
 * 也不會留下孤兒附件或半成品卡片。
 */
export interface ImportFileInput {
  name: string;
  blob: Blob;
  sourcePath?: string;
}

export type ImportStage = "reading" | "parsing" | "saving" | "done" | "failed";

export interface ImportProgress {
  index: number;
  total: number;
  name: string;
  stage: ImportStage;
}

export interface ImportOutcome {
  name: string;
  ok: boolean;
  card?: CardRecord;
  kind: ImportFileKind;
  warnings: string[];
  /** 未取得同意而保留為文字占位的網路圖片。 */
  remoteImages: string[];
  error?: string;
  attachmentIds: string[];
}

export interface ImportBatchResult {
  outcomes: ImportOutcome[];
  cards: CardRecord[];
  succeeded: number;
  failed: number;
  warnings: string[];
  remoteImages: string[];
}

export interface ImportOptions {
  language: AppLanguage;
  allowRemoteImages?: boolean;
  onProgress?: (progress: ImportProgress) => void;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || getImportCopy("zh-TW").importTitle;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] || character);
}

function fail(name: string, kind: ImportFileKind, error: string, attachmentIds: string[], warnings: string[] = []): ImportOutcome {
  return { name, ok: false, kind, warnings, remoteImages: [], error, attachmentIds };
}

/** 只掃描不建立任何資料，用來先列出網路圖片來源網域徵求同意。 */
export async function scanDocument(input: ImportFileInput): Promise<{ kind: ImportFileKind; bytes: number; remoteImages: string[]; warnings: string[] }> {
  const kind = classifyDocument(input.name, input.blob.type);
  const warnings: string[] = [];
  const verdict = checkSizeLimit(kind, input.blob.size);
  if (!verdict.allowed) return { kind, bytes: input.blob.size, remoteImages: [], warnings: ["too-large"] };
  let html = "";
  try {
    if (kind === "markdown") html = (await markdownToRawHtml(input));
    else if (kind === "html") html = sanitizeImportHtml(await input.blob.text(), { allowRemoteImages: true, allowDataImages: true });
  } catch {
    warnings.push("parse-deferred");
  }
  return { kind, bytes: input.blob.size, remoteImages: findRemoteImages(html), warnings };
}

async function markdownToRawHtml(input: ImportFileInput) {
  const chunk = await fromMarkdown(await input.blob.text(), { allowRemoteImages: true });
  return chunk.contentHtml;
}

/** 讀出實際要解析的位元組：桌面 metadataOnly 時要從本機附件取回。 */
async function storedBlob(input: ImportFileInput, attachment: AttachmentRecord, kind: ImportFileKind) {
  const current = input.blob.type === attachment.mime ? input.blob.slice(0, input.blob.size, attachment.mime) : input.blob;
  if (current.size > 0 || !input.sourcePath) return current;
  if (kind === "image" || kind === "audio" || kind === "video") return current;
  const { attachmentUrl } = await import("./attachments");
  const response = await fetch(attachmentUrl(attachment));
  if (!response.ok) throw new Error("source-content-unreadable");
  return await response.blob();
}

/** 把正文中的相對圖片與 data URL 圖片轉成 `role: "inline"` 附件。 */
async function materializeImages(html: string, context: { sourcePath?: string; created: AttachmentRecord[]; warnings: string[]; language: AppLanguage; allowRemoteImages: boolean }) {
  const document = new DOMParser().parseFromString(html || "", "text/html");
  const images = [...document.body.querySelectorAll("img[src]")];
  const copy = getImportCopy(context.language);
  const relativeNames: string[] = [];
  const relativeIndex = new Map<string, number>();
  const mapping: Array<{ match: string; attachmentId: string }> = [];

  images.forEach((image) => {
    const src = image.getAttribute("src") || "";
    if (src.startsWith("attachment://")) return;
    if (/^data:image\//i.test(src)) {
      const blob = dataUrlToBlob(src);
      if (blob.size > IMPORT_LIMITS.remoteImageBytes) {
        image.removeAttribute("src");
        context.warnings.push("image-too-large");
        return;
      }
      const index = relativeIndex.get(src);
      if (index === undefined) {
        relativeIndex.set(src, relativeNames.length);
        relativeNames.push(src);
      }
      return;
    }
    if (/^https?:\/\//i.test(src)) {
      // 已同意的網路圖片：下載失敗就退回文字占位，不留追蹤標籤。
      const index = relativeIndex.get(src);
      if (index === undefined) {
        relativeIndex.set(src, relativeNames.length);
        relativeNames.push(src);
      }
      return;
    }
    const clean = src.split("#")[0].split("?")[0];
    if (!clean || clean.includes("..")) {
      image.removeAttribute("src");
      context.warnings.push("path-traversal");
      return;
    }
    const index = relativeIndex.get(clean);
    if (index === undefined) {
      relativeIndex.set(clean, relativeNames.length);
      relativeNames.push(clean);
    }
  });

  const resolved = new Map<string, { data: string; mime?: string }>();
  const dataEntries = relativeNames.filter((name) => name.startsWith("data:"));
  dataEntries.forEach((name) => resolved.set(name, { data: name.slice(name.indexOf(",") + 1), mime: (name.match(/^data:([^;,]+)/)?.[1] || "image/png") }));
  // 預設不連線：只有使用者在同意介面明確允許後，才會下載網路圖片。
  const httpEntries = context.allowRemoteImages ? relativeNames.filter((name) => /^https?:\/\//i.test(name)) : [];
  if (httpEntries.length) {
    const downloaded = await downloadRemoteAssets(httpEntries);
    for (const asset of downloaded) {
      if (asset.ok && asset.data) resolved.set(asset.url, { data: asset.data, mime: asset.mime });
      else context.warnings.push(asset.error === "too-large" ? "image-too-large" : "image-rejected");
    }
  }
  const localEntries = relativeNames.filter((name) => !resolved.has(name) && !/^https?:\/\//i.test(name));
  if (localEntries.length) {
    const assets = await resolveLocalAssets(context.sourcePath || "", localEntries);
    assets.forEach((asset, index) => {
      const name = asset.name || localEntries[index];
      if (asset.data) resolved.set(name, { data: asset.data, mime: asset.mime });
      else context.warnings.push("asset-missing");
    });
  }

  let totalBytes = 0;
  for (const image of images) {
    const src = image.getAttribute("src") || "";
    const key = src.startsWith("data:")
      ? src
      : /^https?:\/\//i.test(src)
        ? src
        : src.split("#")[0].split("?")[0];
    const entry = resolved.get(key);
    if (!entry) {
      // 找不到或沒下載的資源一律轉成可讀文字占位，
      // 絕不把會發請求（或必定破圖）的 <img> 留進正文。
      if (src && !src.startsWith("data:")) image.replaceWith(document.createTextNode(`[${image.getAttribute("alt") || src}](${src})`));
      else image.remove();
      continue;
    }
    const bytes = Math.floor(entry.data.length * 0.75);
    if (bytes > IMPORT_LIMITS.remoteImageBytes) {
      image.replaceWith(document.createTextNode(`[${image.getAttribute("alt") || copy.inlineImage}](${key})`));
      context.warnings.push("image-too-large");
      continue;
    }
    if (totalBytes + bytes > IMPORT_LIMITS.remoteTotalBytesPerDocument) {
      image.replaceWith(document.createTextNode(`[${image.getAttribute("alt") || copy.inlineImage}](${key})`));
      context.warnings.push("image-too-large");
      continue;
    }
    const mime = entry.mime && entry.mime.startsWith("image/") ? entry.mime : "image/png";
    const name = safeAssetName(key.startsWith("data:") ? `image-${context.created.length}.${mime.split("/")[1] || "png"}` : key.split("/").pop() || `image-${context.created.length}`);
    const attachment = await persistAttachment(name, dataUrlToBlob(`data:${mime};base64,${entry.data}`), mime, undefined, "inline");
    context.created.push(attachment);
    totalBytes += bytes;
    image.setAttribute("src", attachmentRef(attachment.id));
    image.setAttribute("data-attachment-id", attachment.id);
    mapping.push({ match: key, attachmentId: attachment.id });
  }
  return { html: document.body.innerHTML, mapping };
}

async function extractPdf(blob: Blob, language: AppLanguage) {
  const { getPdfDocument } = await import("./pdfRuntime");
  const data = new Uint8Array(await blob.arrayBuffer());
  const loadingTask = getPdfDocument({ data });
  const copy = getImportCopy(language);
  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push((content.items as Array<{ str?: string }>).map((item) => (typeof item?.str === "string" ? item.str : "")).join(" ").replace(/\s+/g, " ").trim());
    }
    const text = pages.map((page, index) => `【${index + 1}】\n${page}`).join("\n\n");
    return { text, pageCount: document.numPages, empty: pages.every((page) => !page) };
  } finally {
    await loadingTask.destroy();
    void copy;
  }
}

interface ParsedDocument {
  kind: CardKind;
  contentHtml: string;
  plainText: string;
  warnings: string[];
  remoteImages: string[];
  properties: Record<string, string | number | boolean | string[] | null>;
}

async function parseDocument(input: ImportFileInput, blob: Blob, options: ImportOptions, created: AttachmentRecord[]): Promise<ParsedDocument> {
  const kind = classifyDocument(input.name, blob.type);
  const language = options.language;
  const copy = getImportCopy(language);
  const warnings: string[] = [];
  const allowRemoteImages = options.allowRemoteImages === true;
  const context = { sourcePath: input.sourcePath, created, warnings, language, allowRemoteImages };

  if (kind === "pdf") {
    const parsed = await extractPdf(blob, language);
    if (parsed.empty) warnings.push("no-text");
    const chunk = await fromPlainText(parsed.text);
    return { kind: "pdf", contentHtml: chunk.contentHtml, plainText: chunk.plainText, warnings, remoteImages: [], properties: { pages: parsed.pageCount } };
  }
  if (kind === "markdown") {
    const chunk = await fromMarkdown(await blob.text(), { allowRemoteImages: true });
    const remoteImages = allowRemoteImages ? [] : findRemoteImages(chunk.contentHtml);
    const materialized = await materializeImages(chunk.contentHtml, context);
    const normalized = await fromHtml(materialized.html, { allowRemoteImages: true, previousHtml: chunk.contentHtml });
    if (remoteImages.length) warnings.push("remote-images-blocked");
    return { kind: "note", contentHtml: normalized.contentHtml, plainText: normalized.plainText, warnings, remoteImages, properties: { format: "Markdown" } };
  }
  if (kind === "html") {
    const source = await blob.text();
    // 危險構造在清理後不會留下字面標記，一律對原始來源做偵測再決定警告。
    const dangerousSource = /<\s*(script|iframe|object|embed|form|style|link|meta|base)\b|\son[a-z]+\s*=|javascript:|vbscript:|data:text\/html/i.test(source);
    const sanitized = sanitizeImportHtml(source, { allowRemoteImages: true, allowDataImages: true });
    const blocked = allowRemoteImages ? [] : findRemoteImages(sanitized);
    const materialized = await materializeImages(sanitized, context);
    const chunk = await fromHtml(materialized.html, { allowRemoteImages: true });
    if (blocked.length) warnings.push("remote-images-blocked");
    if (dangerousSource) warnings.push("blocked-html");
    return { kind: "note", contentHtml: chunk.contentHtml, plainText: chunk.plainText, warnings, remoteImages: blocked, properties: { format: "HTML" } };
  }
  if (kind === "docx") {
    const mammoth = (await import("mammoth/mammoth.browser")).default;
    const result = await mammoth.convertToHtml(
      { arrayBuffer: await blob.arrayBuffer() },
      {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Heading 4'] => h4:fresh",
          "p[style-name='Quote'] => blockquote:fresh",
          "p[style-name='Block Text'] => blockquote:fresh",
          "r[style-name='Code'] => code:fresh",
          "r[style-name='Inline Code'] => code:fresh",
          "r[style-name='Emphasis'] => em:fresh",
          "r[style-name='Strong'] => strong:fresh",
          "p[style-name='Table Caption'] => figcaption:fresh",
        ],
        convertImage: mammoth.images.imgElement(async (image) => {
          const base64 = String(await image.read("base64"));
          const mime = image.contentType && image.contentType.startsWith("image/") ? image.contentType : "image/png";
          if (Math.floor(base64.length * 0.75) > IMPORT_LIMITS.remoteImageBytes) {
            warnings.push("image-too-large");
            return { src: "", alt: image.altText || "" };
          }
          const attachment = await persistAttachment(safeAssetName(`docx-image-${created.length}.${mime.split("/")[1] || "png"}`), dataUrlToBlob(`data:${mime};base64,${base64}`), mime, undefined, "inline");
          created.push(attachment);
          return { src: attachmentRef(attachment.id), alt: image.altText || "" };
        }),
      },
    );
    (result.messages || []).forEach((message) => {
      if (message?.type === "error" || message?.type === "warning") warnings.push(message.message ? `mammoth:${message.message}`.slice(0, 240) : "mammoth");
    });
    const chunk = await fromHtml(result.value || "", { allowRemoteImages: true });
    return { kind: "note", contentHtml: chunk.contentHtml, plainText: chunk.plainText, warnings, remoteImages: [], properties: { format: "Word" } };
  }
  if (kind === "text") {
    const chunk = fromPlainText(await blob.text());
    return { kind: "note", contentHtml: chunk.contentHtml, plainText: chunk.plainText, warnings, remoteImages: [], properties: { format: "TXT" } };
  }
  if (kind === "image") return { kind: "image", contentHtml: `<p>${escapeHtml(input.name)}</p>`, plainText: input.name, warnings, remoteImages: [], properties: {} };
  if (kind === "audio") return { kind: "audio", contentHtml: `<p>${escapeHtml(input.name)}</p>`, plainText: input.name, warnings, remoteImages: [], properties: {} };
  if (kind === "video") return { kind: "video", contentHtml: `<p>${escapeHtml(input.name)}</p>`, plainText: input.name, warnings, remoteImages: [], properties: {} };
  warnings.push("unsupported");
  return { kind: "note", contentHtml: `<p>${escapeHtml(input.name)}</p>`, plainText: input.name, warnings, remoteImages: [], properties: {} };
}

/** 匯入單一檔案並建立一張卡片；失敗時回收本檔建立的附件。 */
export async function importDocument(input: ImportFileInput, options: ImportOptions, index = 0, total = 1): Promise<ImportOutcome> {
  const kind = classifyDocument(input.name, input.blob.type);
  const copy = getImportCopy(options.language);
  const verdict = checkSizeLimit(kind, input.blob.size);
  if (!verdict.allowed) {
    options.onProgress?.({ index, total, name: input.name, stage: "failed" });
    return fail(input.name, kind, copy.warningTooLarge, [], ["too-large"]);
  }
  const created: AttachmentRecord[] = [];
  options.onProgress?.({ index, total, name: input.name, stage: "reading" });
  try {
    const mime = inferAttachmentMime(input.name, input.blob.type);
    const source = await persistAttachment(input.name, input.blob, mime, input.sourcePath, "source");
    created.push(source);
    options.onProgress?.({ index, total, name: input.name, stage: "parsing" });
    const blob = await storedBlob(input, source, kind);
    const parsed = await parseDocument(input, blob, options, created);
    const inlineIds = created.filter((attachment) => attachment.role === "inline").map((attachment) => attachment.id);
    const contentHtml = parsed.contentHtml || "<p></p>";
    const plainText = parsed.plainText || plainTextFromHtml(contentHtml);
    options.onProgress?.({ index, total, name: input.name, stage: "saving" });
    const card = await createCard({
      title: baseName(input.name),
      kind: parsed.kind,
      state: "active",
      contentHtml,
      plainText,
      attachmentIds: [source.id, ...inlineIds],
      properties: { ...parsed.properties, filename: input.name, size: source.size },
      color: parsed.kind === "pdf" ? "rose" : parsed.kind === "image" ? "amber" : parsed.kind === "audio" || parsed.kind === "video" ? "violet" : "slate",
    });
    options.onProgress?.({ index, total, name: input.name, stage: "done" });
    return {
      name: input.name,
      ok: true,
      card,
      kind,
      warnings: parsed.warnings,
      remoteImages: parsed.remoteImages,
      error: undefined,
      attachmentIds: [source.id, ...inlineIds],
    };
  } catch (error) {
    // 只回收這一份文件的附件，同批其他已成功的卡片不受影響。
    for (const attachment of created) await removeStoredAttachment(attachment).catch(() => {});
    options.onProgress?.({ index, total, name: input.name, stage: "failed" });
    const message = error instanceof Error ? error.message : "";
    const friendly = /password|encrypt/i.test(message) ? copy.errorEncrypted : /corrupt|invalid|ENOENT|unreadable/i.test(message) ? copy.errorCorrupted : copy.errorParse;
    return fail(input.name, kind, friendly, [], [message || "parse-failed"]);
  }
}

/** 批次匯入：逐檔回報進度，允許部分成功並保留每張卡的入口。 */
export async function importDocuments(inputs: ImportFileInput[], options: ImportOptions): Promise<ImportBatchResult> {
  const outcomes: ImportOutcome[] = [];
  for (const [index, input] of inputs.entries()) {
    outcomes.push(await importDocument(input, options, index, inputs.length));
  }
  return {
    outcomes,
    cards: outcomes.filter((outcome) => outcome.ok && outcome.card).map((outcome) => outcome.card!),
    succeeded: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    warnings: [...new Set(outcomes.flatMap((outcome) => outcome.warnings))],
    remoteImages: [...new Set(outcomes.flatMap((outcome) => outcome.remoteImages))],
  };
}

export function describeWarning(language: AppLanguage, code: string) {
  const copy = getImportCopy(language);
  const translated = importWarningCopy(language, code);
  return translated === code ? copy.warningUnsupported : translated;
}
