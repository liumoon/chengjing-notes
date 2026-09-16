const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { restoreAttachmentFile, createAttachmentRemovalQueue } = require("./attachment-recovery.cjs");
const attachmentStore = require("./attachment-store.cjs");
const { providerHttpError } = require("./provider-errors.cjs");

test("備份附件驗證失敗不覆寫原檔，成功時使用獨立檔案", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-restore-safe-"));
  try {
    const directory = path.join(root, "attachments"); const assets = path.join(root, "ChengJing-AutoBackup-Assets");
    await fs.mkdir(directory); await fs.mkdir(assets);
    const original = path.join(directory, "same-note.txt"); await fs.writeFile(original, "original");
    const hash = createHash("sha256").update("backup").digest("hex");
    const source = path.join(assets, hash); await fs.writeFile(source, "corrupt");
    const request = { id: "same", name: "note.txt", mime: "text/plain", sha256: hash, backupFilePath: path.join(root, "backup.json") };
    await assert.rejects(restoreAttachmentFile(directory, request), /hash-mismatch/);
    assert.equal(await fs.readFile(original, "utf8"), "original");
    // 還原失敗不留下半檔，也不留下一長串待清理的殘骸
    assert.deepEqual(await fs.readdir(directory), ["objects", "same-note.txt", "staging"]);
    assert.deepEqual(await fs.readdir(path.join(directory, "objects")), []);
    assert.deepEqual(await fs.readdir(path.join(directory, "staging")), []);
    await fs.writeFile(source, "backup");
    const restored = await restoreAttachmentFile(directory, request);
    assert.equal(restored.id, "same");
    assert.match(restored.relativePath, /^objects\/[a-z0-9]{2}\/same\.txt$/);
    assert.equal(await fs.readFile(path.join(directory, restored.relativePath), "utf8"), "backup");
    assert.equal(await fs.readFile(original, "utf8"), "original");
    assert.deepEqual(await fs.readdir(path.join(directory, "staging")), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("附件刪除保留 Undo 的檔案；下次只清除未恢復的附件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-attachment-undo-"));
  try {
    const directory = path.join(root, "attachments"); await fs.mkdir(directory);
    for (const name of ["removed.txt", "restored.txt", "unrelated.txt"]) await fs.writeFile(path.join(directory, name), name);
    const tiered = attachmentStore.newAttachmentRelativePath("tiered-removed", "分層.txt");
    await attachmentStore.writeFileAtomic(directory, tiered, Buffer.from("tiered"));
    const queue = createAttachmentRemovalQueue(directory, root);
    await Promise.all([queue.defer("removed.txt"), queue.defer("restored.txt"), queue.defer(tiered)]);
    assert.deepEqual((await queue.pendingPaths()).sort(), ["removed.txt", "restored.txt", tiered].sort());
    // 3 個舊單層檔 + objects/ + staging/
    assert.equal((await fs.readdir(directory)).length, 5);
    assert.equal(await fs.readFile(path.join(directory, tiered), "utf8"), "tiered");
    await createAttachmentRemovalQueue(directory, root).sweep(["restored.txt"]);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["objects", "restored.txt", "staging", "unrelated.txt"]);
    assert.equal(await fs.stat(path.join(directory, tiered)).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(directory, "restored.txt"), "utf8"), "restored.txt");
    await assert.rejects(queue.defer("../outside"), /invalid-attachment-path/);
    await assert.rejects(queue.defer("/etc/passwd"), /invalid-attachment-path/);
    await assert.rejects(queue.defer("staging/x.part"), /invalid-attachment-path/);
    // 舊 manifest 的單層檔名與非法殘留值都要能安全讀取
    await fs.writeFile(path.join(root, "pending-attachment-removals.json"), JSON.stringify(["legacy.txt", "../evil", "staging/x.part", 42]));
    assert.deepEqual(await createAttachmentRemovalQueue(directory, root).pendingPaths(), ["legacy.txt"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Provider 拒絕、額度與服務錯誤都保留正確原因", () => {
  assert.match(providerHttpError("provider-http-400:Unsupported parameter", "zh-TW"), /已收到請求/);
  assert.match(providerHttpError("provider-http-401", "zh-TW"), /授權/);
  assert.match(providerHttpError("provider-http-429", "zh-TW"), /額度/);
  assert.match(providerHttpError("provider-http-503", "zh-TW"), /服務發生錯誤/);
  for (const language of ["zh-TW", "zh-CN", "en", "ja", "ko"]) assert.equal(typeof providerHttpError("provider-http-404", language), "string");
});
