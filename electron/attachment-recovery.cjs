const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writeAtomic } = require("./secure-json-vault.cjs");
const attachmentStore = require("./attachment-store.cjs");

/**
 * 備份還原與延遲刪除都走 attachment-store 的同一套路徑規則，
 * 因此舊單層附件與新的 `objects/<shard>/<id>.<ext>` 可以共存。
 */
async function restoreAttachmentFile(directory, request) {
  const hash = String(request.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid-backup-attachment");
  const name = attachmentStore.safeAttachmentName(request.name);
  const relativePath = attachmentStore.newAttachmentRelativePath(request.id || randomUUID(), name);
  const source = path.join(path.dirname(path.resolve(String(request.backupFilePath || ""))), "ChengJing-AutoBackup-Assets", hash);
  await attachmentStore.ensureLayout(directory);
  let destination;
  try {
    destination = await attachmentStore.copyFileAtomic(directory, relativePath, source);
    if (await attachmentStore.hashFile(destination) !== hash) throw new Error("backup-asset-hash-mismatch");
    const stat = await fs.stat(destination);
    return { id: request.id, name, mime: request.mime || "application/octet-stream", size: stat.size, storage: "file", relativePath, sha256: hash, createdAt: request.createdAt || Date.now() };
  } catch (error) {
    if (destination) await attachmentStore.removeAttachmentFile(directory, relativePath).catch(() => {});
    throw error;
  }
}

/** Files remain readable by Undo until the next workspace launch. */
function createAttachmentRemovalQueue(directory, userDataDirectory) {
  const manifest = path.join(userDataDirectory, "pending-attachment-removals.json");
  let chain = Promise.resolve();
  const serialized = (operation) => {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  };
  const read = async () => {
    try {
      const data = JSON.parse(await fs.readFile(manifest, "utf8"));
      return (Array.isArray(data) ? data : [])
        .filter((value) => typeof value === "string" && attachmentStore.isSafeRelativePath(value))
        .map((value) => attachmentStore.normalizeRelativePath(value));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    pendingPaths() { return serialized(async () => [...await read()]); },
    defer(relativePath) {
      return serialized(async () => {
        if (!attachmentStore.isSafeRelativePath(relativePath)) throw new Error("invalid-attachment-path");
        const pending = new Set(await read());
        pending.add(attachmentStore.normalizeRelativePath(relativePath));
        await writeAtomic(manifest, Buffer.from(JSON.stringify([...pending])));
        return { removed: true };
      });
    },
    sweep(keepPaths) {
      return serialized(async () => {
        const keep = new Set();
        for (const value of Array.isArray(keepPaths) ? keepPaths : []) {
          try { keep.add(attachmentStore.normalizeRelativePath(value)); }
          catch (_error) { keep.add(path.basename(String(value || ""))); }
        }
        let removed = 0;
        for (const pendingPath of await read()) {
          if (keep.has(pendingPath) || keep.has(path.basename(pendingPath))) continue;
          await attachmentStore.removeAttachmentFile(directory, pendingPath);
          removed += 1;
        }
        await fs.rm(manifest, { force: true });
        return { removed };
      });
    },
  };
}

module.exports = { restoreAttachmentFile, createAttachmentRemovalQueue };
