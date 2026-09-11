"use strict";

/**
 * `window.chengjing.documents` 的原生實作（桌面端）。
 *
 * 兩項能力都服務於文件匯入的附件處理：
 * - `resolveLocalAssets`：只讀取「來源文件所在資料夾」的相對資源（通常是內嵌圖片）。
 * - `downloadRemoteAssets`：只接受公開 HTTP(S) 圖片，逐次檢查重新導向、位址、
 *   MIME 與大小，拒絕 loopback、私有網段與路徑穿越。
 *
 * 安全檢查在此就地執行（不依賴瀏覽器），與渲染端的 `importLimits`／`documentBridge`
 * 互相補強，避免單一層出錯就讓惡意資源進卡。
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const LIMITS = {
  textBytes: 20 * 1024 * 1024,
  docxBytes: 50 * 1024 * 1024,
  pdfBytes: 100 * 1024 * 1024,
  mediaBytes: 200 * 1024 * 1024,
  remoteImageBytes: 10 * 1024 * 1024,
  remoteTotalBytesPerDocument: 50 * 1024 * 1024,
  remoteTimeoutMs: 15_000,
  maxRedirects: 5,
  maxRemoteImagesPerDocument: 40,
};

// detectMime 只依魔法檔頭辨別圖片（內容優先於副檔名，避免類型混淆攻擊）；
// 本地附件與遠端下載都以圖片為對象， unrecognized 內容回傳空字串，
// 由渲染端依需要另行分類（classifyDocument）。
function detectMime(_name, buffer) {
  if (!buffer || buffer.length < 4) return "";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "image/gif";
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  if (buffer[0] === 0x46 && buffer[1] === 0x4f && buffer[2] === 0x57 && buffer[3] === 0x50) return "image/webp";
  return "";
}

/** 解析十進位／八進位／十六進位寫法的 IPv4，避免繞過私有網段檢查。 */
function normalizeIpv4(host) {
  const value = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  const labels = value.split(".");
  if (labels.length === 1 || labels.length === 2 || labels.length === 3 || labels.length === 4) {
    const parts = [];
    for (const label of labels) {
      if (!label) return null;
      let number;
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

function isPrivateAddress(address) {
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
  if (host.includes(":")) {
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

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** URL 解析會把 /../ 正規化，故按斜線切分原始路徑區段以偵測層級穿越。 */
function hasPathTraversal(value) {
  let raw;
  try {
    raw = decodeURIComponent(String(value || "").split("?")[0].split("#")[0]);
  } catch {
    return false;
  }
  return raw.split("/").some((segment) => segment === "..");
}

/** 與渲染端 `assertPublicImageUrl` 一致的遠端圖片准入檢查。 */
function assertPublicImageUrl(value) {
  if (!isHttpUrl(value)) return "unsupported-scheme";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "unsupported-scheme";
  }
  if (url.username || url.password) return "credentials-in-url";
  if (isPrivateAddress(url.hostname)) return "private-address";
  if (hasPathTraversal(value)) return "path-traversal";
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("\u0000")) return "null-byte";
  return "";
}

/** 安全地以來源檔案所在資料夾為界，讀取相對資源。 */
function resolveWithin(baseDir, name) {
  const base = path.resolve(baseDir || "");
  const relative = String(name || "").replace(/\\/g, "/");
  if (relative.includes("..")) return { error: "path-traversal" };
  const candidate = path.resolve(base, relative);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) return { error: "path-traversal" };
  return { base, candidate };
}

async function readLocalAsset(baseDir, name) {
  const resolved = resolveWithin(baseDir, name);
  if (resolved.error) return { name, error: resolved.error };
  const { base, candidate } = resolved;
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return { name, error: "not-found" };
    if (stat.size > LIMITS.remoteImageBytes) return { name, size: stat.size, error: "too-large" };
    const data = (await fs.readFile(candidate)).toString("base64");
    return { name, data, size: stat.size, mime: detectMime(candidate, Buffer.from(data, "base64")), sourcePath: candidate, basePath: base };
  } catch (error) {
    return { name, error: error?.code === "ENOENT" ? "not-found" : error?.message || "resolve-failed" };
  }
}

async function fetchRemoteImage(net, url, options) {
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : LIMITS.maxRedirects;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : LIMITS.remoteTimeoutMs;
  const maxBytes = Number.isInteger(options.maxBytesPerAsset) ? options.maxBytesPerAsset : LIMITS.remoteImageBytes;
  let current = url;
  let redirects = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await net.fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 ChengJing/0.1" },
      });
      const location = response.headers.get("location");
      const status = Number(response.status);
      if (status >= 300 && status < 400 && location) {
        redirects += 1;
        if (redirects > maxRedirects) return { url, ok: false, error: "too-many-redirects" };
        let next;
        try { next = new URL(location, current); } catch { return { url, ok: false, error: "bad-redirect" }; }
        const reason = assertPublicImageUrl(next.href);
        if (reason) return { url, ok: false, error: reason, redirectedTo: next.href };
        current = next.href;
        continue;
      }
      if (!response.ok) return { url, ok: false, error: `http-${status}`, size: 0 };
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) return { url, ok: false, error: "too-large", size: buffer.length };
      return {
        url,
        ok: true,
        data: buffer.toString("base64"),
        mime: detectMime(new URL(current).pathname, buffer),
        size: buffer.length,
        redirectedTo: redirects > 0 ? current : undefined,
      };
    }
  } catch (error) {
    const code = error?.code;
    if (code === "ABORT_ERR" || code === "ETIMEOUT" || code === "ERR_ABORTED") return { url, ok: false, error: "timeout" };
    return { url, ok: false, error: error?.message || "download-failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析來源文件旁的相對資源。桌面僅讀取來源檔案所在資料夾；
 * 回傳每筆資源的 base64／MIME／大小，失敗則留下 `error`。
 */
async function resolveLocalAssets({ sourcePath = "", names = [] } = {}) {
  const baseDir = sourcePath ? path.dirname(path.resolve(sourcePath)) : path.resolve("");
  const assets = (Array.isArray(names) ? names : []).map((name) => readLocalAsset(baseDir, name));
  return { rootPath: baseDir, assets: await Promise.all(assets) };
}

/**
 * 只下載公開 HTTP(S) 圖片。逐次檢查協定、位址、重新導向、MIME 與大小；
 * 非圖片、私有位址、超限或逾時都會回傳 `ok: false` 與原因，不中斷其他下載。
 */
async function downloadRemoteAssets(net, { urls = [], maxBytesPerAsset, maxTotalBytes, timeoutMs, maxRedirects } = {}) {
  const totalBudget = Number.isInteger(maxTotalBytes) ? maxTotalBytes : LIMITS.remoteTotalBytesPerDocument;
  let totalBytes = 0;
  return Promise.all(
    (Array.isArray(urls) ? urls : []).map(async (raw) => {
      const url = String(raw || "");
      const reason = assertPublicImageUrl(url);
      if (reason) return { url, ok: false, error: reason, size: 0 };
      const fetched = await fetchRemoteImage(net, url, { maxBytesPerAsset, maxTotalBytes, timeoutMs, maxRedirects });
      if (!fetched.ok) return fetched;
      // 單張已受 maxBytesPerAsset 限制；此處再守住整份文件的合計上限。
      if (totalBytes + fetched.size > totalBudget) {
        return { ...fetched, ok: false, error: "total-budget-exceeded", size: 0 };
      }
      totalBytes += fetched.size;
      return fetched;
    }),
  );
}

module.exports = {
  LIMITS,
  resolveLocalAssets,
  downloadRemoteAssets,
  // 曝出檢查函式供單元測試直接呼叫。
  __security: { isPrivateAddress, isHttpUrl, assertPublicImageUrl, normalizeIpv4, detectMime },
};
