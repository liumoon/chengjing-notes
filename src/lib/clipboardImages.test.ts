import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { createCard, db } from "../db";
import type { AttachmentRecord } from "../types";
import {
  clipboardImageFileName,
  clipboardMarkdownForAttachments,
  extractClipboardImages,
  isSupportedClipboardImageMime,
  persistClipboardImages,
  persistInlineClipboardImages,
  rollbackInlineClipboardImages,
} from "./clipboardImages";

beforeAll(() => {
  Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle });
  return db.open();
});

beforeEach(async () => {
  for (const table of db.tables) await table.clear();
});

function attachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: "inline-1",
    name: "截圖.png",
    mime: "image/png",
    size: 3,
    blob: new Blob(["png"], { type: "image/png" }),
    storage: "indexeddb",
    createdAt: 1,
    role: "inline",
    ...overrides,
  };
}

describe("剪貼簿圖片辨識", () => {
  it("接受常見圖片 MIME（含 SVG）與檔案項目，拒絕非檔案項目", () => {
    expect(isSupportedClipboardImageMime("IMAGE/PNG")).toBe(true);
    expect(isSupportedClipboardImageMime("image/svg+xml")).toBe(true);

    const png = new File(["png"], "截圖.png", { type: "image/png" });
    const svg = new File(["<svg />"], "image.svg", { type: "image/svg+xml" });
    const event = {
      clipboardData: {
        items: [
          { kind: "string", type: "text/plain", getAsFile: () => null },
          { kind: "file", type: "", getAsFile: () => png },
          { kind: "file", type: "image/svg+xml", getAsFile: () => svg },
        ],
      },
    } as unknown as ClipboardEvent;

    expect(extractClipboardImages(event)).toEqual([
      { blob: png, name: "截圖.png", mime: "image/png" },
      { blob: svg, name: "image.svg", mime: "image/svg+xml" },
    ]);
  });

  it("在檔案 MIME 遺失時依副檔名辨識圖片", () => {
    const png = new File(["png"], "截圖.png", { type: "" });
    const event = { clipboardData: { files: [png] } } as unknown as ClipboardEvent;
    expect(extractClipboardImages(event)).toEqual([{ blob: png, name: "截圖.png", mime: "image/png" }]);
  });

  it("本機檔案圖片不走內嵌流程，交給一般附件流程", () => {
    const png = new File(["png"], "photo.png", { type: "image/png" }) as File & { path: string };
    png.path = "/Users/test/photo.png";
    const event = { clipboardData: { files: [png] } } as unknown as ClipboardEvent;
    expect(extractClipboardImages(event)).toEqual([]);
  });

  it("支援 WebView 以 HTML data URL 提供剪貼簿圖片", async () => {
    const event = {
      clipboardData: {
        items: [{ kind: "string", type: "text/html", getAsFile: () => null }],
        files: [],
        getData: (type: string) => type === "text/html"
          ? '<p>貼圖</p><img alt="內嵌截圖" src="data:image/png;base64,cG5n">'
          : "",
      },
    } as unknown as ClipboardEvent;
    const [image] = extractClipboardImages(event);
    expect(image.mime).toBe("image/png");
    expect(image.name).toBe("內嵌截圖");
    expect(await image.blob.text()).toBe("png");
  });

  it("支援 URL encoded SVG data URL", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
    const event = {
      clipboardData: {
        items: [{ kind: "string", type: "text/html", getAsFile: () => null }],
        files: [],
        getData: (type: string) => type === "text/html"
          ? `<img alt="向量圖" src="data:image/svg+xml,${encodeURIComponent(source)}">`
          : "",
      },
    } as unknown as ClipboardEvent;
    const [image] = extractClipboardImages(event);
    expect(image.mime).toBe("image/svg+xml");
    expect(await image.blob.text()).toContain("<rect");
  });
});

describe("剪貼簿圖片保存", () => {
  it("沒有檔名時產生穩定且安全的圖片檔名", () => {
    const input = { blob: new Blob(["png"], { type: "image/png" }), mime: "image/png" };
    expect(clipboardImageFileName(input, 0, Date.UTC(2026, 8, 11, 1, 2, 3))).toBe("pasted-image-20260911T010203Z.png");
    expect(clipboardImageFileName({ ...input, name: "../截圖" }, 1)).toBe("..-截圖.png");
  });

  it("以 inline role 保存圖片，並在卡片不存在時清理已保存附件", async () => {
    const input = { blob: new Blob(["png"], { type: "image/png" }), mime: "image/png", name: "paste.png" };
    const [saved] = await persistClipboardImages([input]);
    expect(saved.role).toBe("inline");
    expect(saved.mime).toBe("image/png");
    expect(await db.attachments.get(saved.id)).toMatchObject({ role: "inline", name: "paste.png" });

    await expect(persistInlineClipboardImages("missing-card", [input])).rejects.toThrow("card-not-found");
    expect((await db.attachments.toArray()).filter((attachment) => attachment.role === "inline")).toHaveLength(1);
  });

  it("成功時先把所有 inline 附件登錄到卡片", async () => {
    const card = await createCard({ title: "貼圖測試" });
    const saved = await persistInlineClipboardImages(card.id, [
      { blob: new Blob(["one"], { type: "image/png" }), mime: "image/png", name: "one.png" },
      { blob: new Blob(["two"], { type: "image/jpeg" }), mime: "image/jpeg", name: "two.jpg" },
    ]);
    const updated = await db.cards.get(card.id);
    expect(updated?.attachmentIds).toEqual(saved.map((attachment) => attachment.id));
    expect(saved.every((attachment) => attachment.role === "inline")).toBe(true);
  });

  it("並行貼上時不覆蓋另一批已登錄的附件", async () => {
    const card = await createCard({ title: "並行貼圖測試" });
    const [first, second] = await Promise.all([
      persistInlineClipboardImages(card.id, [{ blob: new Blob(["one"], { type: "image/png" }), mime: "image/png", name: "one.png" }]),
      persistInlineClipboardImages(card.id, [{ blob: new Blob(["two"], { type: "image/png" }), mime: "image/png", name: "two.png" }]),
    ]);
    expect((await db.cards.get(card.id))?.attachmentIds.sort()).toEqual([first[0].id, second[0].id].sort());
  });

  it("插入失敗時移除卡片引用與未共用的附件", async () => {
    const card = await createCard({ title: "貼圖測試" });
    const saved = await persistInlineClipboardImages(card.id, [
      { blob: new Blob(["one"], { type: "image/png" }), mime: "image/png", name: "one.png" },
    ]);
    await rollbackInlineClipboardImages(card.id, saved);
    expect((await db.cards.get(card.id))?.attachmentIds).toEqual([]);
    expect(await db.attachments.get(saved[0].id)).toBeUndefined();
  });

  it("回滾時保留仍被其他卡片引用的附件", async () => {
    const first = await createCard({ title: "第一張" });
    const second = await createCard({ title: "第二張" });
    const [saved] = await persistInlineClipboardImages(first.id, [
      { blob: new Blob(["one"], { type: "image/png" }), mime: "image/png", name: "one.png" },
    ]);
    await db.cards.update(second.id, { attachmentIds: [saved.id] });
    await rollbackInlineClipboardImages(first.id, [saved]);
    expect((await db.cards.get(first.id))?.attachmentIds).toEqual([]);
    expect((await db.cards.get(second.id))?.attachmentIds).toEqual([saved.id]);
    expect(await db.attachments.get(saved.id)).toBeDefined();
  });

  it("產生帶有 attachment:// 引用的 Markdown", () => {
    expect(clipboardMarkdownForAttachments([attachment(), attachment({ id: "inline-2", name: "photo.jpg" })]))
      .toBe("![截圖.png](attachment://inline-1)\n\n![photo.jpg](attachment://inline-2)");
  });

  it("保存 SVG 前清理危險內容，附件不含 script 或事件屬性", async () => {
    const input = {
      blob: new Blob(['<svg onload="alert(1)"><script>alert(2)</script><rect onclick="alert(3)" width="4" height="4"/></svg>'], { type: "image/svg+xml" }),
      mime: "image/svg+xml",
      name: "icon.svg",
    };
    const [saved] = await persistClipboardImages([input]);
    const content = await saved.blob?.text();
    expect(saved.role).toBe("inline");
    expect(content?.toLowerCase()).not.toContain("<script");
    expect(content?.toLowerCase()).not.toContain("onload");
    expect(content?.toLowerCase()).not.toContain("onclick");
  });

  it("拒絕無法解析的 SVG 並清理同批已建立的附件", async () => {
    await expect(persistClipboardImages([
      { blob: new Blob(["png"], { type: "image/png" }), mime: "image/png", name: "ok.png" },
      { blob: new Blob(["not-svg"], { type: "image/svg+xml" }), mime: "image/svg+xml", name: "bad.svg" },
    ])).rejects.toThrow("clipboard-svg-rejected");
    expect(await db.attachments.count()).toBe(0);
  });
});
