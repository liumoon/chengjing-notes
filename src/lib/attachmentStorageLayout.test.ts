import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentRecord } from "../types";
import { attachmentUrl } from "./attachments";
import { canonicalizeImageSrcs, resolveInlineImageSrcs } from "./attachmentRefs";

function fileAttachment(overrides: Partial<AttachmentRecord>): AttachmentRecord {
  return {
    id: "6f1d2c3a-1111-2222-3333-444455556666",
    name: "筆記 圖示.png",
    mime: "image/png",
    size: 8,
    storage: "file",
    createdAt: 1,
    ...overrides,
  } as AttachmentRecord;
}

const TIERED = "objects/a1/6f1d2c3a-1111-2222-3333-444455556666.png";
const LEGACY = "6f1d2c3a-1111-2222-3333-444455556666-筆記 圖示.png";

describe("附件分層儲存與舊路徑共存", () => {
  const original = (window as unknown as { chengjing?: unknown }).chengjing;

  afterEach(() => {
    (window as unknown as { chengjing?: unknown }).chengjing = original;
  });

  it("桌面 URL 保留分層相對路徑", () => {
    (window as unknown as { chengjing?: unknown }).chengjing = { platform: "darwin" };
    const tiered = attachmentUrl(fileAttachment({ relativePath: TIERED }));
    const legacy = attachmentUrl(fileAttachment({ relativePath: LEGACY }));
    expect(tiered).toBe(`chengjing-attachment://local/${encodeURIComponent(TIERED)}`);
    expect(legacy).toBe(`chengjing-attachment://local/${encodeURIComponent(LEGACY)}`);
    // 解码後仍指回同一個相對路徑，協議層不會把目錄吃掉
    expect(decodeURIComponent(new URL(tiered).pathname.replace(/^\/+/, ""))).toBe(TIERED);
    expect(decodeURIComponent(new URL(legacy).pathname.replace(/^\/+/, ""))).toBe(LEGACY);
  });

  it("Android URL 保留分層相對路徑並帶 MIME 提示", () => {
    (window as unknown as { chengjing?: unknown }).chengjing = { platform: "android" };
    const tiered = attachmentUrl(fileAttachment({ relativePath: TIERED }));
    const svg = attachmentUrl(fileAttachment({ relativePath: "objects/a1/icon.svg", mime: "image/svg+xml" }));
    expect(tiered).toBe(`https://appassets.androidplatform.net/attachments/${encodeURIComponent(TIERED)}`);
    expect(new URL(tiered).pathname).toBe(`/attachments/${encodeURIComponent(TIERED)}`);
    // Android 以 /attachments/<relativePath> 攔截；剝掉前綴後要還原成同一個相對路徑
    expect(decodeURIComponent(new URL(tiered).pathname.replace(/^\/attachments\//, ""))).toBe(TIERED);
    expect(svg.endsWith("?mime=image%2Fsvg%2Bxml")).toBe(true);
  });

  it("富文字畫面能在分層與舊路徑之間往返還原附件參照", () => {
    (window as unknown as { chengjing?: unknown }).chengjing = { platform: "darwin" };
    const attachments = [
      fileAttachment({ relativePath: TIERED }),
      fileAttachment({ id: "legacy-id", relativePath: LEGACY }),
    ];
    const rendered = resolveInlineImageSrcs(
      `<p><img src="attachment://${attachments[0].id}"><img src="attachment://${attachments[1].id}"></p>`,
      attachments,
    );
    expect(rendered.html).toContain(encodeURIComponent(TIERED));
    expect(rendered.html).toContain(encodeURIComponent(LEGACY));
    const canonical = canonicalizeImageSrcs(rendered.html, attachments);
    expect(canonical).toContain(`attachment://${attachments[0].id}`);
    expect(canonical).toContain(`attachment://${attachments[1].id}`);
    expect(canonical).not.toContain("objects/");
    for (const url of rendered.resolved) URL.revokeObjectURL(url);
  });
});
