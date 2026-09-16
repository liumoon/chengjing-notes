import { assertPublicImageUrl, IMPORT_LIMITS, isPrivateAddress } from "./importLimits";

/**
 * `window.chengjing.documents` 的安全包裝。
 *
 * 桌面只允許讀取來源文件所在資料夾；Android 遇到相對圖片時，
 * 由原生以 Storage Access Framework 請使用者選取一次資源資料夾。
 * 遠端下載一律在这里做協定、位址、大小與逾時覆核。
 */
export interface ResolvedLocalAsset {
  name: string;
  data?: string;
  sourcePath?: string;
  mime?: string;
  error?: string;
}

export interface DownloadedRemoteAsset {
  url: string;
  ok: boolean;
  data?: string;
  mime?: string;
  size?: number;
  error?: string;
}

function bridge() {
  return typeof window === "undefined" ? undefined : window.chengjing?.documents;
}

export function documentsBridgeAvailable() {
  return Boolean(bridge());
}

/** 解析來源文件旁的相對資源（通常是圖片）。 */
export async function resolveLocalAssets(sourcePath: string, names: string[]): Promise<ResolvedLocalAsset[]> {
  const bridgeApi = bridge();
  if (!bridgeApi || !names.length) return names.map((name) => ({ name, error: "bridge-unavailable" }));
  try {
    let result = await bridgeApi.resolveLocalAssets({ sourcePath, names });
    // Android：相對圖片落在來源文件旁的資料夾，必須由使用者以 SAF 授權一次。
    if (result?.needsFolder && bridgeApi.pickAssetFolder) {
      const picked = await bridgeApi.pickAssetFolder();
      if (picked?.rootPath) result = await bridgeApi.resolveLocalAssets({ sourcePath, names });
      else return names.map((name) => ({ name, error: "folder-not-selected" }));
    }
    if (!result || !Array.isArray(result.assets)) return names.map((name) => ({ name, error: "bad-response" }));
    return result.assets.map((asset, index) => {
      const name = String(asset?.name || names[index] || "");
      const data = typeof asset?.data === "string" ? asset.data : undefined;
      const error = typeof asset?.error === "string" ? asset.error : data ? undefined : "not-found";
      if (data && typeof asset?.size === "number" && asset.size > IMPORT_LIMITS.remoteImageBytes) return { name, error: "too-large" };
      return { name, data, sourcePath: typeof asset?.sourcePath === "string" ? asset.sourcePath : undefined, mime: typeof asset?.mime === "string" ? asset.mime : undefined, error };
    });
  } catch (error) {
    return names.map((name) => ({ name, error: error instanceof Error ? error.message : "resolve-failed" }));
  }
}

/** 只接受公開 HTTP(S) 圖片；逐次檢查重新導向、位址、MIME 與大小。 */
export async function downloadRemoteAssets(urls: string[]): Promise<DownloadedRemoteAsset[]> {
  const bridgeApi = bridge();
  const safe: string[] = [];
  const rejected = new Map<string, DownloadedRemoteAsset>();
  for (const url of urls) {
    const reason = assertPublicImageUrl(url);
    if (reason) rejected.set(url, { url, ok: false, error: reason });
    else safe.push(url);
  }
  if (!safe.length) return [...rejected.values()];
  if (!bridgeApi?.downloadRemoteAssets) {
    return [...safe.map((url) => ({ url, ok: false, error: "bridge-unavailable" })), ...rejected.values()];
  }
  try {
    const result = await bridgeApi.downloadRemoteAssets({
      urls: safe,
      maxBytesPerAsset: IMPORT_LIMITS.remoteImageBytes,
      maxTotalBytes: IMPORT_LIMITS.remoteTotalBytesPerDocument,
      timeoutMs: IMPORT_LIMITS.remoteTimeoutMs,
      maxRedirects: IMPORT_LIMITS.maxRedirects,
    });
    const assets = Array.isArray(result?.assets) ? result.assets : [];
    const downloaded: DownloadedRemoteAsset[] = assets.map((asset) => {
      const url = String(asset?.url || "");
      const mime = typeof asset?.mime === "string" ? asset.mime : "";
      const size = typeof asset?.size === "number" ? asset.size : 0;
      if (!asset?.ok) return { url, ok: false, error: typeof asset?.error === "string" ? asset.error : "download-failed" };
      if (!mime.startsWith("image/")) return { url, ok: false, error: "not-an-image" };
      if (size > IMPORT_LIMITS.remoteImageBytes) return { url, ok: false, error: "too-large" };
      if (asset.redirectedTo && isPrivateAddress(new URL(String(asset.redirectedTo)).hostname)) return { url, ok: false, error: "redirect-to-private" };
      return { url, ok: true, data: typeof asset.data === "string" ? asset.data : undefined, mime, size };
    });
    return [...downloaded, ...rejected.values()];
  } catch (error) {
    return [...safe.map((url) => ({ url, ok: false, error: error instanceof Error ? error.message : "download-failed" })), ...rejected.values()];
  }
}

/** 下載結果的 `data` 是純 base64；換回 Blob 才能存成附件。 */
export function remoteAssetBlob(asset: DownloadedRemoteAsset): Blob | null {
  if (!asset?.ok || typeof asset.data !== "string" || !asset.data) return null;
  try {
    if (typeof atob !== "function") return null;
    const binary = atob(asset.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: asset.mime || "application/octet-stream" });
  } catch {
    return null;
  }
}

/** 從網址取一個安全的檔名，供附件與 alt 文字使用。 */
export function remoteAssetName(url: string) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "remote-image";
    return decodeURIComponent(last).slice(0, 120) || "remote-image";
  } catch {
    return "remote-image";
  }
}
