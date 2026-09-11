/**
 * 文件匯入的硬性上限。超限的檔案在建立卡片之前就被擋下，
 * 因此不會留下「半成品卡片」。
 */
export const IMPORT_LIMITS = {
  textBytes: 20 * 1024 * 1024,
  docxBytes: 50 * 1024 * 1024,
  pdfBytes: 100 * 1024 * 1024,
  mediaBytes: 200 * 1024 * 1024,
  svgBytes: 10 * 1024 * 1024,
  svgMaxNodes: 10_000,
  svgMaxDepth: 32,
  remoteImageBytes: 10 * 1024 * 1024,
  remoteTotalBytesPerDocument: 50 * 1024 * 1024,
  remoteTimeoutMs: 15_000,
  maxRedirects: 5,
  maxRemoteImagesPerDocument: 40,
} as const;

export type ImportFileKind = "text" | "markdown" | "html" | "docx" | "pdf" | "image" | "audio" | "video" | "other";

export function classifyDocument(name: string, mime = ""): ImportFileKind {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || mime === "text/markdown") return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || mime === "text/html") return "html";
  if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) return "docx";
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/.test(lower)) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || /\.(txt|csv|json|log|rtf?)$/.test(lower)) return "text";
  return "other";
}

export function isSvgDocument(name: string, mime = "") {
  return String(mime || "").toLowerCase() === "image/svg+xml" || /\.svg$/i.test(String(name || ""));
}

export function sizeLimitFor(kind: ImportFileKind, name = "", mime = "") {
  switch (kind) {
    case "docx": return IMPORT_LIMITS.docxBytes;
    case "pdf": return IMPORT_LIMITS.pdfBytes;
    case "audio":
    case "video": return IMPORT_LIMITS.mediaBytes;
    case "image": return isSvgDocument(name, mime) ? IMPORT_LIMITS.svgBytes : IMPORT_LIMITS.mediaBytes;
    default: return IMPORT_LIMITS.textBytes;
  }
}

export interface SizeVerdict {
  allowed: boolean;
  limit: number;
}

export function checkSizeLimit(kind: ImportFileKind, bytes: number, name = "", mime = ""): SizeVerdict {
  const limit = sizeLimitFor(kind, name, mime);
  return { allowed: Number.isFinite(bytes) && bytes >= 0 && bytes <= limit, limit };
}

/** 只允許 HTTP／HTTPS，且拒絕直接 IP 以外的詭異協定。 */
export function isHttpUrl(value: string) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 解析十進位／八進位／十六進位寫法的 IPv4，避免繞過私有網段檢查。 */
export function normalizeIpv4(host: string) {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  const labels = value.split(".");
  if (labels.length === 1 || labels.length === 2 || labels.length === 3 || labels.length === 4) {
    const parts: number[] = [];
    for (const label of labels) {
      if (!label) return null;
      let number: number;
      if (/^0x[0-9a-f]+$/.test(label)) number = parseInt(label, 16);
      else if (/^0[0-7]+$/.test(label)) number = parseInt(label, 8);
      else if (/^\d+$/.test(label)) number = Number(label);
      else return null;
      if (!Number.isInteger(number) || number < 0 || number > 255) {
        if (labels.length === 1 && number > 0xffffffff) return null;
        if (labels.length > 1 && number > 255) return null;
      }
      parts.push(number);
    }
    if (parts.length === 1) {
      const total = parts[0];
      if (!Number.isInteger(total) || total < 0 || total > 0xffffffff) return null;
      return [(total >>> 24) & 255, (total >>> 16) & 255, (total >>> 8) & 255, total & 255];
    }
    if (parts.length === 2) return [parts[0], 0, 0, parts[1]];
    if (parts.length === 3) return [parts[0], parts[1], 0, parts[2]];
    return parts;
  }
  return null;
}

/** loopback、私有網段、連結本地、雲中 metadata 一律視為不安全。 */
export function isPrivateAddress(address: string) {
  const host = String(address || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "metadata" || host === "metadata.google.internal" || host === "metadata.goog") return true;
  const v4 = normalizeIpv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const v6 = host.includes(":");
  if (v6) {
    if (host === "::" || host === "::1") return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
    if (host.startsWith("fe80") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true;
    if (host.startsWith("ff")) return true;
    const mapped = host.match(/::ffff:([0-9.]+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/** URL 解析會把 /../ 正規化，故按斜線切分原始路徑區段以偵測層級穿越。 */
export function hasPathTraversal(value: string): boolean {
  let raw: string;
  try {
    raw = decodeURIComponent(String(value || "").split("?")[0].split("#")[0]);
  } catch {
    return false;
  }
  return raw.split("/").some((segment) => segment === "..");
}

export function assertPublicImageUrl(value: string) {
  if (!isHttpUrl(value)) return "unsupported-scheme";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "unsupported-scheme";
  }
  if (url.username || url.password) return "credentials-in-url";
  if (isPrivateAddress(url.hostname)) return "private-address";
  if (hasPathTraversal(value)) return "path-traversal";
  const path = decodeURIComponent(url.pathname);
  if (path.includes("\u0000")) return "null-byte";
  return "";
}
