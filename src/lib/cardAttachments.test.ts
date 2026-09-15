import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { createCard, db } from "../db";
import { addSelectedAttachmentsToCard, selectedAttachmentBlob } from "./cardAttachments";

beforeAll(() => {
  Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle });
  return db.open();
});

beforeEach(async () => {
  for (const table of db.tables) await table.clear();
});

describe("卡片附件加入流程", () => {
  it("可保存瀏覽器檔案與 native data URL 檔案，並登錄到同一張卡片", async () => {
    const card = await createCard({ title: "附件測試" });
    const data = btoa("native file");
    const result = await addSelectedAttachmentsToCard(card.id, [
      { name: "note.txt", blob: new Blob(["browser file"], { type: "text/plain" }) },
      { name: "native.txt", data },
    ]);

    expect(result.failures).toHaveLength(0);
    expect(result.attachments).toHaveLength(2);
    expect((await db.cards.get(card.id))?.attachmentIds).toEqual(result.attachments.map((attachment) => attachment.id));
    expect((await db.attachments.toArray()).map((attachment) => attachment.role)).toEqual(["attachment", "attachment"]);
    await expect(selectedAttachmentBlob({ name: "native.txt", data }).text()).resolves.toBe("native file");
  });

  it("卡片更新失敗時會清理已保存的附件", async () => {
    await expect(addSelectedAttachmentsToCard("missing-card", [{ name: "orphan.txt", blob: new Blob(["orphan"]) }])).rejects.toThrow("card-not-found");
    expect(await db.attachments.count()).toBe(0);
  });
});
