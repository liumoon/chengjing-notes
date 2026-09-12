import { describe, expect, it } from "vitest";
import { classifySyncError, safeSyncDetail, wrapSyncError } from "./syncErrors";

describe("sync error diagnostics", () => {
  it("classifies attachment transfer failures by stage", () => {
    expect(classifySyncError(new Error("offline"), "upload").kind).toBe("attachment-upload");
    expect(classifySyncError(new Error("offline"), "download").kind).toBe("attachment-download");
  });

  it("classifies auth, permission, protocol, and network errors", () => {
    expect(classifySyncError(Object.assign(new Error("unauthorized"), { status: 401 })).kind).toBe("auth");
    expect(classifySyncError(Object.assign(new Error("forbidden"), { status: 403 })).kind).toBe("permission");
    expect(classifySyncError(new Error("sync-invalid-packet")).kind).toBe("protocol");
    expect(classifySyncError(new Error("network timeout")).kind).toBe("network");
  });

  it("redacts bearer and query credentials", () => {
    expect(safeSyncDetail("Bearer secret-token https://example.test/?api_key=secret")).not.toContain("secret-token");
    expect(safeSyncDetail("Bearer secret-token https://example.test/?api_key=secret")).not.toContain("secret");
  });

  it("keeps a stable machine-readable code on wrapped errors", () => {
    const error = wrapSyncError("upload", new Error("remote unavailable")) as Error & { code?: string };
    expect(error.code).toBe("sync-attachment-upload-failed");
    expect(error.message).toContain("sync-attachment-upload-failed");
  });
});
