import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { chromium } from "playwright";

/**
 * 附件分層儲存端到端驗證。
 *
 * 走真正的 Electron 主程序與 `chengjing-attachment://` 協定，確認：
 * 新附件落在 `objects/<shard>/<id>`、舊單層附件照舊可讀、staging 永不外洩、
 * 統計遞迴涵蓋兩代格式、刪除與備份還原不會留下半檔或孤兒附件。
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const tempData = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-attachment-store-"));
const autoBackupTarget = path.join(tempData, "automatic-backups");
const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-attachment-source-"));
const port = await freePort();
const child = spawn(electronPath, [".", `--remote-debugging-port=${port}`], {
  cwd: process.cwd(),
  env: { ...process.env, CHENGJING_SMOKE: "1", CHENGJING_SMOKE_USER_DATA: tempData, CHENGJING_SMOKE_AUTO_BACKUP_DIR: autoBackupTarget },
  stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });
let browser;
const attachmentsRoot = path.join(tempData, "attachments");
const report = {};
const failures = [];

async function check(label, passed, detail) {
  report[label] = passed;
  if (!passed) failures.push({ label, detail });
}

try {
  const endpoint = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
    if (Date.now() - started > 20_000) throw new Error(`主程序啟動逾時：${childOutput.slice(-800)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.waitForEvent("page");
  page.setDefaultTimeout(15_000);
  await page.waitForFunction(() => Boolean(window.chengjing?.attachments), null, { timeout: 20_000 });

  const text = "澄境分層附件測試：標題、圖片與中文檔名";
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");

  // 1) importData → 新分層路徑
  const imported = await page.evaluate(async (data) => ({ fromData: await window.chengjing.attachments.importData({ id: "qa-tiered-1", name: "筆記 圖示.txt", mime: "text/plain", data }) }), Buffer.from(text, "utf8").toString("base64"));
  await check("importData 使用 objects/<shard>/<id> 路徑", /^objects\/[a-z0-9]{2}\/qa-tiered-1\.txt$/.test(imported.fromData.relativePath || ""), imported.fromData);
  await check("importData 寫入 sha256 與 size", imported.fromData.sha256 === crypto.createHash("sha256").update(text).digest("hex") && imported.fromData.size === Buffer.byteLength(text), imported.fromData);

  // 2) 真正從外部檔案匯入
  const external = path.join(sourceDir, "原始來源.PNG");
  await fs.writeFile(external, png);
  const importedPath = await page.evaluate((sourcePath) => window.chengjing.attachments.importPath({ id: "qa-tiered-2", sourcePath, name: "原始來源.PNG", mime: "image/png" }), external);
  await check("importPath 使用分層路徑並保留副檔名小寫", /^objects\/[a-z0-9]{2}\/qa-tiered-2\.png$/.test(importedPath.relativePath || ""), importedPath);
  await check("importPath 保留原始顯示名稱", importedPath.name === "原始來源.PNG", importedPath);

  // 3) 協定可讀
  const fetched = await page.evaluate(async (relativePath) => {
    const response = await fetch(`chengjing-attachment://local/${encodeURIComponent(relativePath)}`);
    return { status: response.status, text: await response.text() };
  }, imported.fromData.relativePath);
  await check("協定可讀分層附件", fetched.status === 200 && fetched.text === text, fetched);
  const fetchedImage = await page.evaluate(async (relativePath) => {
    const response = await fetch(`chengjing-attachment://local/${encodeURIComponent(relativePath)}`);
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  }, importedPath.relativePath);
  await check("協定可讀分層圖片", fetchedImage.status === 200 && fetchedImage.bytes === png.byteLength, fetchedImage);

  // 4) 舊單層附件照舊可讀、照舊計入統計
  const legacyName = "legacy-7c0f-report.txt";
  await fs.mkdir(attachmentsRoot, { recursive: true });
  await fs.writeFile(path.join(attachmentsRoot, legacyName), "legacy");
  const legacyRead = await page.evaluate((relativePath) => window.chengjing.attachments.readData(relativePath), legacyName);
  const legacyFetch = await page.evaluate(async (relativePath) => {
    const response = await fetch(`chengjing-attachment://local/${encodeURIComponent(relativePath)}`);
    return { status: response.status, text: await response.text() };
  }, legacyName);
  await check("舊單層附件仍可由 bridge 讀取", Buffer.from(legacyRead || "", "base64").toString("utf8") === "legacy", legacyRead);
  await check("舊單層附件仍可經協定顯示", legacyFetch.status === 200 && legacyFetch.text === "legacy", legacyFetch);

  // 5) staging 永不外洩
  await fs.mkdir(path.join(attachmentsRoot, "staging"), { recursive: true });
  await fs.writeFile(path.join(attachmentsRoot, "staging", "half-written.part"), "half");
  const stagingRead = await page.evaluate((relativePath) => window.chengjing.attachments.readData(relativePath).then(() => "readable").catch(() => "rejected"), "staging/half-written.part");
  const stagingFetch = await page.evaluate(async (relativePath) => (await fetch(`chengjing-attachment://local/${encodeURIComponent(relativePath)}`)).status, "staging/half-written.part");
  await check("staging 無法經 bridge 讀取", stagingRead === "rejected", stagingRead);
  await check("staging 無法經協定讀取", stagingFetch === 404, stagingFetch);

  // 6) 穿越與絕對路徑一律拒絕
  const outside = path.join(tempData, "outside-secret.txt");
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(attachmentsRoot, "escape.txt")).catch(() => {});
  const traversal = await page.evaluate(async () => {
    const attempt = (promise) => Promise.resolve(promise).then(() => "readable").catch(() => "rejected");
    return {
      parent: await attempt(window.chengjing.attachments.readData("../outside-secret.txt")),
      absolute: await attempt(window.chengjing.attachments.readData("/etc/hosts")),
      symlink: await attempt(window.chengjing.attachments.readData("escape.txt")),
      protocolParent: (await fetch("chengjing-attachment://local/..%2Foutside-secret.txt")).status,
      protocolSymlink: (await fetch(`chengjing-attachment://local/${encodeURIComponent("escape.txt")}`)).status,
    };
  });
  await check("拒絕 .. 穿越", traversal.parent === "rejected" && traversal.protocolParent === 404, traversal);
  await check("拒絕絕對路徑", traversal.absolute === "rejected", traversal);
  await check("拒絕符號連結逃離附件根目錄", traversal.symlink === "rejected" && traversal.protocolSymlink === 404, traversal);

  // 7) 統計遞迴涵蓋新舊兩代，且不含 staging
  const stats = await page.evaluate(() => window.chengjing.attachments.stats());
  const expectedBytes = Buffer.byteLength(text) + png.byteLength + Buffer.byteLength("legacy");
  await check("統計遞迴計算新舊附件且排除 staging", stats.count === 3 && stats.bytes === expectedBytes, { stats, expectedBytes });

  // 8) 刪除走延遲清理，Undo 期間檔案仍在
  await page.evaluate((relativePath) => window.chengjing.attachments.remove(relativePath), importedPath.relativePath);
  const pending = await page.evaluate(() => window.chengjing.attachments.pendingPaths());
  const stillReadable = await fs.readFile(path.join(attachmentsRoot, importedPath.relativePath)).catch(() => null);
  await check("刪除後檔案仍在 Undo 視窗內", pending.includes(importedPath.relativePath) && Buffer.compare(stillReadable ?? Buffer.alloc(0), png) === 0, { pending, bytes: stillReadable?.byteLength ?? -1 });
  const swept = await page.evaluate((keep) => window.chengjing.attachments.sweepPending(keep), [imported.fromData.relativePath, legacyName]);
  await check("sweep 後分層檔與空 shard 一併清掉", swept.removed === 1 && await fs.stat(path.join(attachmentsRoot, importedPath.relativePath)).then(() => false).catch(() => true), swept);
  const shardDirs = await fs.readdir(path.join(attachmentsRoot, "objects")).catch(() => []);
  await check("清空後的 shard 不殘留空目錄", shardDirs.length === 1, shardDirs);

  // 9) 自動備份與單檔還原
  const backup = await page.evaluate(async (attachment) => {
    await window.chengjing.backups.chooseFolder();
    await window.chengjing.backups.updateSettings({ enabled: true, intervalDays: 1, retentionCount: 3 });
    const data = JSON.stringify({ format: "chengjing-backup", version: 2, exportedAt: new Date().toISOString(), data: { cards: [{ id: "qa-storage" }], attachments: [attachment] } });
    return window.chengjing.backups.write({ data, reason: "manual", assets: [{ relativePath: attachment.relativePath, sha256: attachment.sha256, size: attachment.size }] });
  }, imported.fromData);
  const backupAsset = await fs.readFile(path.join(autoBackupTarget, "ChengJing-AutoBackup-Assets", imported.fromData.sha256), "utf8").catch(() => "");
  await check("自動備份複製分層附件", backup.copiedAssets === 1 && backupAsset === text, { backup, backupAsset: backupAsset.slice(0, 40) });

  const restored = await page.evaluate(async ({ attachment, backupFilePath }) => {
    await window.chengjing.attachments.remove(attachment.relativePath);
    const result = await window.chengjing.attachments.restoreFromBackup({ ...attachment, backupFilePath });
    const response = await fetch(`chengjing-attachment://local/${encodeURIComponent(result.relativePath)}`);
    return { result, text: await response.text(), status: response.status };
  }, { attachment: imported.fromData, backupFilePath: backup.filePath });
  await check("備份還原寫回分層路徑且內容一致", /^objects\/[a-z0-9]{2}\//.test(restored.result.relativePath || "") && restored.status === 200 && restored.text === text, restored);

  // 10) 不留暫存殘骸
  await fs.rm(path.join(attachmentsRoot, "staging", "half-written.part"), { force: true });
  const stagingAfter = await fs.readdir(path.join(attachmentsRoot, "staging")).catch(() => []);
  const backupTemp = (await fs.readdir(autoBackupTarget).catch(() => [])).filter((name) => name.includes(".tmp-"));
  await check("全流程結束不留 .part 或 .tmp 殘骸", stagingAfter.length === 0 && backupTemp.length === 0, { stagingAfter, backupTemp });

  const unexpectedErrors = childOutput.split("\n").filter((line) => /attachment-protocol/.test(line) && !/staging|escape|\.\.%2F/.test(line));
  await check("主程序未因正常附件操作拋錯", unexpectedErrors.length === 0, unexpectedErrors.slice(0, 3));

  console.log(JSON.stringify({ ok: failures.length === 0, report, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  if (childOutput.trim()) console.error(childOutput.slice(-1_500));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  if (child.exitCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  await fs.rm(tempData, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
  await fs.rm(sourceDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
}
