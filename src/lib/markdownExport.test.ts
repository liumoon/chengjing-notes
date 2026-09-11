import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { db } from "../db";
import { restoreBackup } from "./backup";
import { buildCardMarkdown } from "./markdownExport";
import { uniqueArchiveName } from "./backupValidation";
import type { AttachmentRecord, CardRecord } from "../types";

beforeAll(() => { Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle }); return db.open(); });
beforeEach(async () => { for (const table of db.tables) await table.clear(); });

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: "card-1",
    title: "筆記",
    kind: "note",
    state: "active",
    // contentHtml 是 HTML：用 <strong>/<a> 而非 Markdown 語法。
    contentHtml: '<h1>筆記</h1><p><strong>粗體</strong> 和 <a href="https://ex.com">連結</a>。</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div><p>待辦</p></div></li></ul>',
    plainText: "筆記",
    attachmentIds: [],
    tagIds: [],
    favorite: false,
    color: "slate",
    properties: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function inlineImage(name: string): AttachmentRecord {
  return { id: "img-1", name, mime: "image/png", size: 10, blob: new Blob([], { type: "image/png" }), storage: "indexeddb", createdAt: 1, role: "inline" };
}

describe("buildCardMarkdown 匯出格式", () => {
  it("用真正的 serializer 保留標題、粗體、連結與核取清單", async () => {
    const doc = await buildCardMarkdown(card(), []);
    expect(doc.markdown).toContain("# 筆記");
    expect(doc.markdown).toContain("**粗體**");
    expect(doc.markdown).toContain("[連結](https://ex.com)");
    expect(doc.markdown).toContain("- [ ] 待辦");
    expect(doc.filename).toBe("筆記.md");
  });

  it("有內嵌圖片時改寫成 assets/ 相對路徑", async () => {
    const image = inlineImage("photo.png");
    const withImage = card({ attachmentIds: [image.id], contentHtml: '<h1>筆記</h1><p>圖</p><img src="attachment://img-1" alt="photo">' });
    const doc = await buildCardMarkdown(withImage, [image]);
    expect(doc.markdown).toContain("assets/photo.png");
    expect(doc.assets.map((asset) => asset.path)).toEqual(["assets/photo.png"]);
  });
});

describe("重複標題安全檔名", () => {
  it("相同標題加上序號而不覆蓋", () => {
    const used = new Set<string>();
    const a = uniqueArchiveName("筆記", used);
    const b = uniqueArchiveName("筆記", used);
    const c = uniqueArchiveName("筆記", used);
    expect([a, b, c]).toEqual(["筆記", "筆記 (2)", "筆記 (3)"]);
  });

  it("保留中文檔名", () => {
    const used = new Set<string>();
    expect(uniqueArchiveName("會議結論", used)).toBe("會議結論");
  });
});

describe("舊 JSON 備份可正常還原", () => {
  it("沒有 role 欄位的舊附件仍還原成功", async () => {
    // 模擬版本 1 備份：附件沒有 role 欄位，blob 為 data URL。
    const legacyCard = card();
    const payload = {
      format: "chengjing-backup",
      version: 1,
      data: {
        cards: [legacyCard],
        boards: [],
        boardNodes: [],
        boardEdges: [],
        attachments: [{ id: "old-1", name: "old.png", mime: "image/png", size: 5, blob: "data:image/png;base64,iVBORw0KGgo=", storage: "indexeddb", createdAt: 1 }],
        tags: [],
        tasks: [],
        highlights: [],
      },
    };
    await restoreBackup(JSON.stringify(payload));
    expect(await db.cards.get(legacyCard.id)).toBeTruthy();
    const attachment = await db.attachments.get("old-1");
    expect(attachment).toBeTruthy();
    // 舊附件視為一般附件，不影響匯出與顯示。
    expect(attachment?.role).toBeUndefined();
  });
});
