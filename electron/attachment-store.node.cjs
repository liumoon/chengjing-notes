const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const attachmentStore = require("./attachment-store.cjs");

async function workspace(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { root, attachments: path.join(root, "attachments") };
}

test("新附件使用 objects/<shard>/<id> 分層路徑，副檔名正規化", () => {
  const first = attachmentStore.newAttachmentRelativePath("6f1d2c3a-1111-2222-3333-444455556666", "筆記 圖示.PNG");
  assert.match(first, /^objects\/[a-z0-9]{2}\/6f1d2c3a-1111-2222-3333-444455556666\.png$/);
  assert.equal(first.split("/")[2].endsWith(".png"), true);
  // 同一個 ID 永遠落在同一個 shard
  assert.equal(attachmentStore.newAttachmentRelativePath("6f1d2c3a-1111-2222-3333-444455556666", "other.jpg").split("/")[1], first.split("/")[1]);
  // 不使用標題、日期或原始檔名建立資料夾
  assert.equal(first.includes("筆記"), false);
  // 沒有副檔名時不留下多餘的點
  assert.equal(attachmentStore.newAttachmentRelativePath("abc", "README").endsWith("abc"), true);
});

test("路徑驗證拒絕絕對路徑、穿越、隱藏檔與 staging", () => {
  for (const bad of ["", "/", "../secret", "objects/../secret", "objects/a/../b/x", "/etc/passwd", "C:\\Windows\\system32", "\\\\host\\share", "staging/x.part", "objects/staging/x.part", ".hidden", "objects/a1/.hidden"]) {
    assert.equal(attachmentStore.isSafeRelativePath(bad), false, bad);
    assert.throws(() => attachmentStore.resolveAttachmentPath("/tmp/attachments", bad), /invalid-attachment-path/, bad);
  }
  assert.equal(attachmentStore.isSafeRelativePath("legacy-note.txt"), true);
  assert.equal(attachmentStore.isSafeRelativePath("objects/a1/6f1d2c3a.png"), true);
  assert.equal(attachmentStore.isManagedRelativePath("legacy-note.txt"), true);
  assert.equal(attachmentStore.isManagedRelativePath("objects/a1/6f1d2c3a.png"), true);
  assert.equal(attachmentStore.isManagedRelativePath("2026/asset.txt"), false);
  // 讀得懂不代表是本管線寫出的格式：shard 名稱不正確時仍不納入清理與統計
  assert.equal(attachmentStore.isSafeRelativePath("objects/abc/x.png"), true);
  assert.equal(attachmentStore.isManagedRelativePath("objects/abc/x.png"), false);
  assert.equal(attachmentStore.isSafeRelativePath("objects/x.png"), true);
  assert.equal(attachmentStore.isManagedRelativePath("objects/x.png"), false);
});

test("staging 寫入採原子 rename，成功後不留半檔", async () => {
  const { root, attachments } = await workspace("chengjing-store-atomic-");
  try {
    const relativePath = attachmentStore.newAttachmentRelativePath("attach-1", "筆記.txt");
    const destination = await attachmentStore.writeFileAtomic(attachments, relativePath, Buffer.from("hello"));
    assert.equal(await fs.readFile(destination, "utf8"), "hello");
    assert.deepEqual((await fs.readdir(path.join(attachments, attachmentStore.STAGING_DIRECTORY))), []);
    assert.equal((await attachmentStore.listAttachmentFiles(attachments)).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("舊單層與新分層附件共存：讀取、統計與清理都涵蓋兩者", async () => {
  const { root, attachments } = await workspace("chengjing-store-mixed-");
  try {
    const legacy = "legacy-7c0f-report.pdf";
    await fs.mkdir(attachments, { recursive: true });
    await fs.writeFile(path.join(attachments, legacy), "old");
    const tiered = attachmentStore.newAttachmentRelativePath("7c0f-new", "新附件.png");
    await attachmentStore.writeFileAtomic(attachments, tiered, Buffer.from("new-new"));
    // staging 與非受管目錄不計入統計
    await fs.writeFile(attachmentStore.stagingFile(attachments), "x");
    await fs.mkdir(path.join(attachments, "unmanaged"), { recursive: true });
    await fs.writeFile(path.join(attachments, "unmanaged", "stray.txt"), "stray");
    await fs.writeFile(path.join(attachments, ".DS_Store"), "junk");

    const stats = await attachmentStore.directoryStats(attachments);
    assert.equal(stats.count, 2);
    assert.equal(stats.bytes, 3 + 7);
    assert.deepEqual((await attachmentStore.listAttachmentFiles(attachments)).map((file) => file.relativePath).sort(), [legacy, tiered].sort());

    const cleaned = await attachmentStore.cleanupAttachments(attachments, [legacy]);
    assert.equal(cleaned.removed, 1);
    assert.equal(await fs.readFile(path.join(attachments, legacy), "utf8"), "old");
    assert.equal(await fs.stat(path.join(attachments, tiered)).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(attachments, "unmanaged", "stray.txt"), "utf8"), "stray");
    assert.equal(await fs.readFile(path.join(attachments, ".DS_Store"), "utf8"), "junk");
    // staging 的暫存檔仍在原地，但不會被當成附件讀取或統計
    assert.deepEqual((await attachmentStore.listAttachmentFiles(attachments)).map((file) => file.relativePath), [legacy]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("刪除分層附件後清空 shard，但不動其他 shard", async () => {
  const { root, attachments } = await workspace("chengjing-store-remove-");
  try {
    const first = attachmentStore.newAttachmentRelativePath("aaaa1111", "a.txt");
    const second = attachmentStore.newAttachmentRelativePath("bbbb2222", "b.txt");
    await attachmentStore.writeFileAtomic(attachments, first, Buffer.from("a"));
    await attachmentStore.writeFileAtomic(attachments, second, Buffer.from("b"));
    await attachmentStore.removeAttachmentFile(attachments, first);
    assert.equal(await fs.stat(path.join(attachments, first)).catch(() => null), null);
    assert.equal((await fs.readFile(path.join(attachments, second), "utf8")), "b");
    assert.deepEqual((await attachmentStore.listAttachmentFiles(attachments)).map((file) => file.relativePath), [second]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("符號連結不可把附件讀寫導向根目錄之外", async () => {
  const { root, attachments } = await workspace("chengjing-store-symlink-");
  try {
    const outside = path.join(root, "outside.txt");
    await fs.mkdir(attachments, { recursive: true });
    await fs.writeFile(outside, "secret");
    await fs.symlink(outside, path.join(attachments, "escape.txt"));
    await assert.rejects(attachmentStore.resolveReadablePath(attachments, "escape.txt"), /invalid-attachment-path/);

    const outsideDir = path.join(root, "outside-dir");
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "deep.txt"), "secret");
    await fs.symlink(outsideDir, path.join(attachments, "escape-dir"));
    await assert.rejects(attachmentStore.resolveReadablePath(attachments, "escape-dir/deep.txt"), /invalid-attachment-path/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("copyFileAtomic 來源不存在時不留下目標檔", async () => {
  const { root, attachments } = await workspace("chengjing-store-copyfail-");
  try {
    const relativePath = attachmentStore.newAttachmentRelativePath("missing-src", "x.txt");
    await assert.rejects(attachmentStore.copyFileAtomic(attachments, relativePath, path.join(root, "nope.bin")));
    assert.equal(await fs.stat(path.join(attachments, relativePath)).catch(() => null), null);
    assert.deepEqual(await attachmentStore.listAttachmentFiles(attachments), []);
    assert.deepEqual(await fs.readdir(path.join(attachments, attachmentStore.STAGING_DIRECTORY)), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("來源與目標同路徑時直接沿用，不自我複製", async () => {
  const { root, attachments } = await workspace("chengjing-store-same-");
  try {
    const relativePath = attachmentStore.newAttachmentRelativePath("same-id", "note.txt");
    const written = await attachmentStore.writeFileAtomic(attachments, relativePath, Buffer.from("payload"));
    await attachmentStore.copyFileAtomic(attachments, relativePath, written);
    assert.equal(await fs.readFile(written, "utf8"), "payload");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("附件檔名保留中文與 CJK，但不會寫出目錄分隔字元", () => {
  assert.equal(attachmentStore.safeAttachmentName("  2026/09 筆記:研究?.md  "), "2026-09 筆記-研究-.md");
  assert.equal(attachmentStore.safeAttachmentName(".."), "attachment");
  assert.equal(attachmentStore.safeAttachmentName("a\u0000b"), "a-b");
  assert.equal(attachmentStore.safeExtension("研究.V0.2.PDF"), ".pdf");
  assert.equal(attachmentStore.safeExtension("no-extension"), "");
});

test("staging 目錄永遠不會被列為可讀附件", async () => {
  const { root, attachments } = await workspace("chengjing-store-staging-");
  try {
    await attachmentStore.ensureLayout(attachments);
    const temporary = attachmentStore.stagingFile(attachments);
    await fs.writeFile(temporary, "half-written");
    assert.deepEqual(await attachmentStore.listAttachmentFiles(attachments), []);
    assert.throws(() => attachmentStore.resolveAttachmentPath(attachments, path.relative(attachments, temporary)), /invalid-attachment-path/);
    assert.equal((await attachmentStore.directoryStats(attachments)).bytes, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("清理 keep 同時接受完整相對路徑與舊檔名", async () => {
  const { root, attachments } = await workspace("chengjing-store-keep-");
  try {
    const tiered = attachmentStore.newAttachmentRelativePath("keep-me", "keep.png");
    await attachmentStore.writeFileAtomic(attachments, tiered, Buffer.from("keep"));
    await fs.writeFile(path.join(attachments, "legacy.txt"), "legacy");
    // 完整相對路徑與舊檔名都能作為保留依據
    assert.equal((await attachmentStore.cleanupAttachments(attachments, [tiered, "legacy.txt"])).removed, 0);
    assert.equal((await attachmentStore.cleanupAttachments(attachments, [path.basename(tiered), "legacy.txt"])).removed, 0);
    assert.equal((await attachmentStore.cleanupAttachments(attachments, [tiered])).removed, 1);
    assert.equal(await fs.readFile(path.join(attachments, tiered), "utf8"), "keep");
    assert.equal((await attachmentStore.cleanupAttachments(attachments, [])).removed, 1);
    assert.equal((await fs.readdir(path.join(attachments, attachmentStore.OBJECTS_DIRECTORY))).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("copyFileAtomic 覆寫前保留原內容直到 rename 完成", async () => {
  const { root, attachments } = await workspace("chengjing-store-overwrite-");
  try {
    const relativePath = attachmentStore.newAttachmentRelativePath("over", "a.txt");
    await attachmentStore.writeFileAtomic(attachments, relativePath, Buffer.from("first"));
    const source = path.join(root, "source.bin");
    await fs.writeFile(source, "second");
    await attachmentStore.copyFileAtomic(attachments, relativePath, source);
    assert.equal(await fs.readFile(path.join(attachments, relativePath), "utf8"), "second");
    assert.deepEqual(await fs.readdir(path.join(attachments, attachmentStore.STAGING_DIRECTORY)), []);
    const stat = await fs.stat(path.join(attachments, relativePath));
    assert.equal((stat.mode & 0o777), 0o600);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
