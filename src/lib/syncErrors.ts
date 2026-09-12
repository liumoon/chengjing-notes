export type SyncErrorKind =
  | "network"
  | "auth"
  | "attachment-upload"
  | "attachment-download"
  | "protocol"
  | "permission"
  | "unknown";

export type SyncStage = "list" | "get" | "put" | "stage" | "upload" | "download";

export interface SyncErrorInfo {
  kind: SyncErrorKind;
  code: string;
  retryable: boolean;
  detail: string;
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function statusFrom(error: unknown, text: string) {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return status;
  const match = text.match(/\bHTTP\s*(\d{3})\b|\bstatus(?: code)?[:= ]+(\d{3})\b/i);
  return Number(match?.[1] || match?.[2] || 0);
}

/** Keep diagnostics useful without exposing bearer tokens or query credentials. */
export function safeSyncDetail(error: unknown) {
  return errorText(error)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/([?&](?:api[_-]?key|token|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
    .trim()
    .slice(0, 280);
}

export function classifySyncError(error: unknown, stage?: SyncStage): SyncErrorInfo {
  const rawDetail = safeSyncDetail(error);
  const detail = rawDetail.replace(/^sync-[a-z-]+:\s*/i, "").trim();
  const text = rawDetail.toLowerCase();
  const status = statusFrom(error, rawDetail);
  if (stage === "upload" || /sync-attachment-upload-failed/.test(text)) return { kind: "attachment-upload", code: "sync-attachment-upload-failed", retryable: true, detail };
  if (stage === "download" || /sync-attachment-download-failed/.test(text)) return { kind: "attachment-download", code: "sync-attachment-download-failed", retryable: true, detail };
  if (/sync-invalid|invalid-(?:packet|operation|record)|schema|validation|malformed|json parse/.test(text)) {
    return { kind: "protocol", code: "sync-protocol-invalid", retryable: false, detail };
  }
  if (status === 401 || /unauthori[sz]ed|sign[- ]?in|login|token expired|authentication/.test(text)) {
    return { kind: "auth", code: "sync-auth-required", retryable: false, detail };
  }
  if (status === 403 || /forbidden|permission|access denied|insufficient scope|not allowed/.test(text)) {
    return { kind: "permission", code: "sync-permission-denied", retryable: false, detail };
  }
  if (status === 408 || status === 429 || status >= 500 || /network|offline|timed? ?out|timeout|fetch failed|connection|econn|enotfound|dns/.test(text)) {
    return { kind: "network", code: "sync-network-failed", retryable: true, detail };
  }
  return { kind: "unknown", code: "sync-failed", retryable: true, detail };
}

export function wrapSyncError(stage: SyncStage, error: unknown) {
  const info = classifySyncError(error, stage === "upload" || stage === "download" ? stage : undefined);
  const wrapped = new Error(`${info.code}: ${info.detail || "sync failed"}`);
  Object.assign(wrapped, { code: info.code, syncError: info });
  return wrapped;
}
