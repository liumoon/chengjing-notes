import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { db } from "../db";
import { importDocuments, importDocument } from "./importPipeline";
import type { ImportFileInput } from "./importPipeline";

beforeAll(() => { Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle }); return db.open(); });
beforeEach(async () => { for (const table of db.tables) await table.clear(); });

function file(name: string, content: string, type: string): ImportFileInput {
  return { name, blob: new Blob([content], { type }), sourcePath: `/home/note/${name}` };
}

describe("一檔一卡與部分成功", () => {
  it("單一 Markdown 檔成功匯入並建立一張卡片", async () => {
    const outcome = await importDocument(file("note.md", "# 標題\n\n內容文字", "text/markdown"), { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.card?.title).toBe("note");
    expect(outcome.card?.contentHtml).toContain("<h1>標題</h1>");
    expect(outcome.kind).toBe("markdown");
    // 來源附件保留，供下載原始文件。
    expect(outcome.attachmentIds.length).toBeGreaterThanOrEqual(1);
  });

  it("多档汇入能部分成功：好的 Markdown 建立卡片，損毀 DOCX 失敗", async () => {
    const good = file("good.md", "# 好的\n\n文字", "text/markdown");
    // 損毀的 DOCX（非 OOXML）會解析失敗。
    const corrupt = file("corrupt.docx", "this is not a word document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const result = await importDocuments([good, corrupt], { language: "zh-TW" });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.cards.length).toBe(1);
  });

  it("中途失敗不留下孤兒附件、不回滾同批成功的卡片", async () => {
    const good = file("good.md", "# 好的\n\n文字", "text/markdown");
    const corrupt = file("corrupt.docx", "not a real docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await importDocuments([good, corrupt], { language: "zh-TW" });
    // 只有一張卡片。
    expect(await db.cards.count()).toBe(1);
    // 損毀檔建立的來源附件已被回收，不留孤兒。
    const attachments = await db.attachments.toArray();
    const names = attachments.map((attachment) => attachment.name);
    expect(names).toContain("good.md");
    expect(names).not.toContain("corrupt.docx");
  });

  it("超過大小上限的檔案不建立半成品卡片", async () => {
    const big = new Blob([new Array(21 * 1024 * 1024).join("x")], { type: "text/plain" });
    const outcome = await importDocument({ name: "huge.txt", blob: big, sourcePath: "/x/huge.txt" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(false);
    expect(typeof outcome.error).toBe("string");
    expect(await db.cards.count()).toBe(0);
  });
});
