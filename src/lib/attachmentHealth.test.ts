import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, createCard } from "../db";
import { cleanOrphanAttachments, inspectAttachmentHealth } from "./attachmentHealth";

beforeAll(() => db.open());
beforeEach(async () => {
  for (const table of db.tables) await table.clear();
});

function attachment(id: string, name = `${id}.png`) {
  const blob = new Blob(["image"], { type: "image/png" });
  return { id, name, mime: "image/png", size: blob.size, blob, storage: "indexeddb" as const, createdAt: Date.now() };
}

describe("附件健康中心", () => {
  it("把卡片正文、卡片附件與歷史版本都視為有效引用", async () => {
    const current = attachment("current");
    const bodyOnly = attachment("body-only");
    const historyOnly = attachment("history-only");
    const orphan = attachment("orphan");
    await db.attachments.bulkAdd([current, bodyOnly, historyOnly, orphan]);
    const card = await createCard({
      id: "card-1",
      title: "保留",
      attachmentIds: ["current"],
      contentHtml: `<p><img src="attachment://${bodyOnly.id}"></p>`,
    });
    await db.cardVersions.add({
      id: "version-1",
      cardId: card.id,
      title: card.title,
      contentHtml: `<p><img src="attachment://${historyOnly.id}"></p>`,
      plainText: "",
      createdAt: Date.now(),
    });

    const report = await inspectAttachmentHealth();
    expect(report.orphaned).toBe(1);
    expect(report.entries.find((entry) => entry.attachment.id === "current")?.issues).not.toContain("orphan");
    expect(report.entries.find((entry) => entry.attachment.id === "body-only")?.issues).not.toContain("orphan");
    expect(report.entries.find((entry) => entry.attachment.id === "history-only")?.issues).not.toContain("orphan");
    expect(report.entries.find((entry) => entry.attachment.id === "orphan")?.issues).toContain("orphan");
  });

  it("清理孤兒附件但不刪除歷史引用", async () => {
    const kept = attachment("kept");
    const orphan = attachment("orphan");
    await db.attachments.bulkAdd([kept, orphan]);
    await createCard({ id: "card-2", title: "卡片", attachmentIds: [kept.id] });

    const result = await cleanOrphanAttachments();
    expect(result.removed).toEqual(["orphan"]);
    expect(result.failed).toEqual([]);
    expect(await db.attachments.get("kept")).toBeDefined();
    expect(await db.attachments.get("orphan")).toBeUndefined();
  });

  it("標記 IndexedDB blob 遺失與 size 不一致", async () => {
    await db.attachments.bulkAdd([
      { ...attachment("missing"), blob: undefined },
      { ...attachment("wrong-size"), size: 999 },
    ]);
    const report = await inspectAttachmentHealth();
    expect(report.entries.find((entry) => entry.attachment.id === "missing")?.issues).toEqual(expect.arrayContaining(["orphan", "missing-blob"]));
    expect(report.entries.find((entry) => entry.attachment.id === "wrong-size")?.issues).toEqual(expect.arrayContaining(["orphan", "size-mismatch"]));
  });
});
