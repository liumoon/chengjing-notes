import { describe, expect, it } from "vitest";
import {
  attachmentRef,
  attachmentIdFromRef,
  canonicalizeImageSrcs,
  exportAssetPath,
  inlineImageMarkdown,
  isAttachmentRef,
  referencedAttachmentIds,
  resolveInlineImageSrcs,
  rewriteRefsForExport,
  rewriteRefsForImport,
  safeAssetName,
} from "./attachmentRefs";
import type { AttachmentRecord } from "../types";

function attachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return { id: "att-1", name: "photo.png", mime: "image/png", size: 10, blob: new Blob([], { type: "image/png" }), storage: "indexeddb", createdAt: 1, ...overrides };
}

describe("attachment:// 內部表示", () => {
  it("建立與解析引用", () => {
    expect(attachmentRef("att-1")).toBe("attachment://att-1");
    expect(isAttachmentRef("attachment://att-1")).toBe(true);
    expect(attachmentIdFromRef("attachment://att-1")).toBe("att-1");
    expect(isAttachmentRef("https://ex.com/a.png")).toBe(false);
  });
});

describe("safeAssetName 安全檔名", () => {
  it("清除危險字元並截斷", () => {
    expect(safeAssetName("photo.png")).toBe("photo.png");
    expect(safeAssetName("a/b:c?*d")).toBe("a-b-c-d");
    expect(safeAssetName("")).toBe("attachment");
    expect(safeAssetName("x")).toHaveLength(1);
  });

  it("exportAssetPath 输出 assets/ 相對路徑", () => {
    expect(exportAssetPath(attachment({ name: "photo.png" }))).toBe("assets/photo.png");
  });
});

describe("富文字畫面解析與存庫還原", () => {
  it("resolveInlineImageSrcs 把 attachment:// 換成桌面本機顯示 URL", () => {
    const html = '<p>圖</p><img src="attachment://att-1">';
    const result = resolveInlineImageSrcs(html, [attachment({ storage: "file", relativePath: "files/photo.png" })]);
    // 桌面以 chengjing-attachment://local/… 顯示，不再保留 attachment://<id> 內部形式。
    expect(result.html).toContain("chengjing-attachment://local");
    expect(result.html).toContain("data-attachment-id=\"att-1\"");
    expect(result.html).not.toContain("attachment://att-1");
  });

  it("canonicalizeImageSrcs 把本機 URL 還原成 attachment://", () => {
    const html = '<img src="files/photo.png">';
    const result = canonicalizeImageSrcs(html, [attachment({ relativePath: "files/photo.png" })]);
    expect(result).toContain('src="attachment://att-1"');
  });

  it("優先使用編輯器保留的附件識別並移除畫面專用標記", () => {
    const html = '<img src="chengjing-attachment://local/stale.png" data-attachment-id="att-1">';
    const result = canonicalizeImageSrcs(html, [attachment({ relativePath: "files/photo.png" })]);
    expect(result).toContain('src="attachment://att-1"');
    expect(result).not.toContain("data-attachment-id");
  });
});

describe("匯出改寫為 assets/ 相對路徑", () => {
  it("rewriteRefsForExport 把引用換成相對路徑", () => {
    const md = "文字\n\n![alt](attachment://att-1)";
    const result = rewriteRefsForExport(md, [attachment({ name: "photo.png" })]);
    expect(result).toContain("![alt](assets/photo.png)");
  });

  it("rewriteRefsForImport 把相對路徑換回 attachment://", () => {
    const md = "![alt](assets/photo.png)";
    const result = rewriteRefsForImport(md, [{ match: "assets/photo.png", attachmentId: "att-1" }]);
    expect(result).toBe("![alt](attachment://att-1)");
  });
});

describe("referencedAttachmentIds", () => {
  it("列出正文引用的附件 ID", () => {
    const html = '<img src="attachment://att-1"><img src="attachment://att-2">';
    expect(referencedAttachmentIds(html).sort()).toEqual(["att-1", "att-2"]);
  });

  it("inlineImageMarkdown 產生內嵌圖片語法", () => {
    expect(inlineImageMarkdown("圖", "att-1")).toBe("![圖](attachment://att-1)");
  });
});
