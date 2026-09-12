import { classifySyncError, type SyncErrorKind } from "./syncErrors";

const storage = typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
export type SyncActivity = {
  phase: "idle" | "syncing" | "error";
  error: string;
  errorDetail: string;
  errorKind: SyncErrorKind | "";
  errorCode: string;
  errorRetryable: boolean;
  lastSuccessAt: number;
  lastErrorAt: number;
};
let activity: SyncActivity = {
  phase: "idle",
  error: "",
  errorDetail: "",
  errorKind: "",
  errorCode: "",
  errorRetryable: false,
  lastSuccessAt: Number(storage?.getItem("chengjing-sync-last-success")) || 0,
  lastErrorAt: 0,
};
const listeners = new Set<() => void>();
export const getSyncActivity = () => activity;
export function subscribeSyncActivity(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function reportSyncActivity(phase: SyncActivity["phase"], error = "", completed = phase === "idle") {
  const lastSuccessAt = completed ? Date.now() : activity.lastSuccessAt;
  if (completed) storage?.setItem("chengjing-sync-last-success", String(lastSuccessAt));
  const diagnosed = phase === "error" ? classifySyncError(error) : null;
  activity = {
    phase,
    error: diagnosed?.detail || error,
    errorDetail: diagnosed?.detail || error,
    errorKind: diagnosed?.kind || "",
    errorCode: diagnosed?.code || "",
    errorRetryable: diagnosed?.retryable || false,
    lastSuccessAt,
    lastErrorAt: phase === "error" ? Date.now() : activity.lastErrorAt,
  };
  listeners.forEach(listener => listener());
}
export function syncStatusKind(enabled: boolean, working: boolean, error: string, pending: number, lastSuccessAt: number) {
  if (working) return "working";
  if (error) return "error";
  if (!enabled) return "paused";
  if (pending > 0) return "pending";
  return lastSuccessAt ? "ready" : "waiting";
}
