const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream } = require("node:fs");

/**
 * 附件儲存管線（桌面與備份共用同一套路徑規則）。
 *
 * attachments/
 *   ├── <legacy>.<ext>          舊單層附件：永遠可讀，不搬移、不批次遷移
 *   ├── objects/ab/<id>.<ext>   新附件：依附件 ID 前兩碼分 shard
 *   └── staging/<uuid>.part     寫入中的暫存，對外一律不可見
 *
 * `relativePath` 對呼叫端是不透明字串：新舊格式都要能讀、能刪、能備份。
 * 資料夾只依附件 ID 分 shard，不使用標題、日期或原始檔名，避免檔名衝突、
 * 跨裝置路徑差異，以及把使用者內容寫進檔案系統結構。
 */
const OBJECTS_DIRECTORY = "objects";
const STAGING_DIRECTORY = "staging";
const SHARD_PATTERN = /^[a-z0-9]{2}$/;

function safeAttachmentName(value) {
  const cleaned = String(value || "attachment").replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-").replace(/\s+/g, " ").trim();
  const name = cleaned.replace(/^\.+/, "") || "attachment";
  return name.slice(0, 160);
}

function safeFileId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120) || randomUUID();
}

function safeExtension(name) {
  const extension = path.extname(String(name || "")).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 11);
  return extension ? `.${extension}` : "";
}

function shardFor(value) {
  return createHash("sha256").update(String(value || randomUUID()), "utf8").digest("hex").slice(0, 2);
}

/** 新附件的正式相對路徑：`objects/<shard>/<fileId><ext>`。 */
function newAttachmentRelativePath(id, name = "") {
  const fileId = safeFileId(id);
  return `${OBJECTS_DIRECTORY}/${shardFor(fileId)}/${fileId}${safeExtension(name)}`;
}

/** 正規化並驗證相對路徑；拒絕絕對路徑、`..`、控制字元與空段。 */
function normalizeRelativePath(value) {
  const raw = String(value ?? "");
  // 絕對路徑、UNC 與 Windows 磁碟機一律拒絕；附件只認根目錄下的相對路徑。
  if (/^\//.test(raw) || /^\\/.test(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) throw new Error("invalid-attachment-path");
  const normalized = raw.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f]/.test(normalized)) throw new Error("invalid-attachment-path");
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("invalid-attachment-path");
  return normalized;
}

/** 可安全存取的路徑：不穿越根目錄、不碰 staging、不碰隱藏檔。 */
function isSafeRelativePath(value) {
  let normalized;
  try { normalized = normalizeRelativePath(value); } catch (_error) { return false; }
  const segments = normalized.split("/");
  // staging 是寫入中的暫存區，任何層級都不得對外可見。
  return segments.every((segment) => segment !== STAGING_DIRECTORY && !segment.startsWith("."));
}

/** 本管線自己寫出的正式路徑：舊單層檔名或 `objects/<shard>/<file>`。 */
function isManagedRelativePath(value) {
  if (!isSafeRelativePath(value)) return false;
  const segments = normalizeRelativePath(value).split("/");
  if (segments.length === 1) return true;
  return segments.length === 3 && segments[0] === OBJECTS_DIRECTORY && SHARD_PATTERN.test(segments[1]);
}

function resolveAttachmentPath(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) throw new Error("invalid-attachment-path");
  const base = path.resolve(root);
  const candidate = path.resolve(base, normalizeRelativePath(relativePath));
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) throw new Error("invalid-attachment-path");
  return candidate;
}

/** symlink 防護：已存在的節點，其真實路徑必須落在附件根目錄內。 */
async function assertContained(root, target) {
  const realRoot = await fs.realpath(path.resolve(root));
  let cursor = path.resolve(target);
  for (;;) {
    let real = null;
    try {
      real = await fs.realpath(cursor);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        const parent = path.dirname(cursor);
        if (parent === cursor) throw new Error("invalid-attachment-path");
        cursor = parent;
        continue;
      }
      throw error;
    }
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new Error("invalid-attachment-path");
    return;
  }
}

async function resolveReadablePath(root, relativePath) {
  const filePath = resolveAttachmentPath(root, relativePath);
  await assertContained(root, filePath);
  return filePath;
}

async function ensureLayout(root) {
  const base = path.resolve(root);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(base, STAGING_DIRECTORY), { recursive: true, mode: 0o700 });
  return base;
}

function stagingFile(root) {
  return path.join(path.resolve(root), STAGING_DIRECTORY, `${randomUUID()}.part`);
}

async function promote(root, temporary, relativePath) {
  const destination = resolveAttachmentPath(root, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.rename(temporary, destination);
  await fs.chmod(destination, 0o600).catch(() => {});
  return destination;
}

async function syncFile(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r+");
    await handle.sync();
  } catch (_error) {
    // 部分檔案系統不支援 fsync；資料已落地，忽略即可。
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** staging 完整寫入 ＋ fsync ＋ 原子 rename；失敗不留下半檔。 */
async function writeFileAtomic(root, relativePath, data) {
  await ensureLayout(root);
  const temporary = stagingFile(root);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncFile(temporary);
    return await promote(root, temporary, relativePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function copyFileAtomic(root, relativePath, sourcePath) {
  await ensureLayout(root);
  const temporary = stagingFile(root);
  try {
    await fs.copyFile(sourcePath, temporary, fs.constants.COPYFILE_EXCL);
    await syncFile(temporary);
    return await promote(root, temporary, relativePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** 列出受管理的正式附件；一律排除 staging、隱藏檔與非受管目錄。 */
async function listAttachmentFiles(root) {
  const base = await ensureLayout(root);
  const found = [];
  async function walk(directory, prefix) {
    let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // 只走 objects/ 與其兩字元 shard，其他目錄一概不碰。
        if (!prefix ? relative === OBJECTS_DIRECTORY : prefix === OBJECTS_DIRECTORY && SHARD_PATTERN.test(entry.name)) await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !isManagedRelativePath(relative)) continue;
      const stat = await fs.stat(absolute);
      found.push({ relativePath: relative, size: stat.size });
    }
  }
  await walk(base, "");
  return found;
}

async function directoryStats(root) {
  const files = await listAttachmentFiles(root);
  return { bytes: files.reduce((total, file) => total + file.size, 0), count: files.length };
}

async function removeAttachmentFile(root, relativePath) {
  const filePath = resolveAttachmentPath(root, relativePath);
  await fs.rm(filePath, { force: true });
  const parent = path.dirname(filePath);
  if (parent !== path.resolve(root)) await fs.rmdir(parent).catch(() => {});
  return true;
}

function keepSet(keepPaths) {
  const keep = new Set();
  for (const value of Array.isArray(keepPaths) ? keepPaths : []) {
    const raw = String(value ?? "");
    try { keep.add(normalizeRelativePath(raw)); } catch (_error) { keep.add(path.basename(raw)); }
  }
  return keep;
}

function isKept(keep, relativePath) {
  return keep.has(relativePath) || keep.has(path.basename(relativePath));
}

/** 以 keep 清單清掉孤兒附件；只處理受管理路徑，其餘檔案原封不動。 */
async function cleanupAttachments(root, keepPaths) {
  const base = await ensureLayout(root);
  const keep = keepSet(keepPaths);
  let removed = 0;
  for (const file of await listAttachmentFiles(base)) {
    if (isKept(keep, file.relativePath)) continue;
    await removeAttachmentFile(base, file.relativePath);
    removed += 1;
  }
  return { removed };
}

module.exports = {
  OBJECTS_DIRECTORY,
  STAGING_DIRECTORY,
  assertContained,
  cleanupAttachments,
  copyFileAtomic,
  directoryStats,
  ensureLayout,
  hashFile,
  isManagedRelativePath,
  isSafeRelativePath,
  listAttachmentFiles,
  newAttachmentRelativePath,
  normalizeRelativePath,
  promote,
  removeAttachmentFile,
  resolveAttachmentPath,
  resolveReadablePath,
  safeAttachmentName,
  safeExtension,
  safeFileId,
  stagingFile,
  writeFileAtomic,
};
