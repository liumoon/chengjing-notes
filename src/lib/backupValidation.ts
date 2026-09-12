const REQUIRED_TABLES = ["cards", "boards", "boardNodes", "boardEdges", "tags", "tasks", "attachments"];

export interface BackupInspection {
  version: number;
  cardCount: number;
  attachmentCount: number;
  taskCount: number;
  boardCount: number;
  boardNodeCount: number;
  attachmentReferenceCount: number;
  missingAttachmentIds: string[];
  warningCodes: string[];
  restorable: boolean;
}

export function validateBackup(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("backup-invalid");
  const parsed = value as { format?: string; version?: number; data?: Record<string, unknown>; communityIdentity?: unknown };
  if (parsed.format !== "chengjing-backup" || ![1, 2].includes(parsed.version || 0) || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) throw new Error("backup-invalid");
  for (const name of REQUIRED_TABLES) if (!Array.isArray(parsed.data[name])) throw new Error("backup-invalid");
  for (const [name, records] of Object.entries(parsed.data)) {
    if (!Array.isArray(records)) throw new Error("backup-invalid");
    const keys = new Set<string>();
    for (const record of records) {
      const key = record?.[name === "preferences" ? "key" : "id"];
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof key !== "string" || !key || keys.has(key)) throw new Error("backup-invalid");
      keys.add(key);
    }
  }
  for (const record of parsed.data.cards as Array<Record<string, unknown>>) {
    if (!["title", "contentHtml", "plainText", "kind", "state"].every((key) => typeof record[key] === "string") || !Array.isArray(record.tagIds) || !Array.isArray(record.attachmentIds)) throw new Error("backup-invalid");
    if (record.sourceUrl) { try { const url = new URL(String(record.sourceUrl)); if (!["https:", "http:"].includes(url.protocol)) throw new Error(); } catch { throw new Error("backup-invalid"); } }
  }
  return parsed as { format: string; version: number; data: Record<string, Array<Record<string, unknown>>>; communityIdentity?: unknown };
}

/**
 * Summarize a validated backup without mutating the database or reading
 * attachment bytes. Missing attachment references are warnings: the rest of
 * the JSON backup can still be restored and inspected by the user.
 */
export function inspectBackup(value: unknown): BackupInspection {
  const parsed = validateBackup(value);
  const data = parsed.data;
  const attachments = data.attachments || [];
  const attachmentIds = new Set(attachments.map((item) => String(item.id)));
  const referencedIds = new Set<string>();
  for (const card of data.cards || []) {
    for (const id of Array.isArray(card.attachmentIds) ? card.attachmentIds : []) {
      if (typeof id === "string" && id) referencedIds.add(id);
    }
    const content = String(card.contentHtml || "");
    for (const match of content.matchAll(/attachment:\/\/([A-Za-z0-9_-]+)/g)) referencedIds.add(match[1]);
  }
  for (const version of data.cardVersions || []) {
    const content = String(version.contentHtml || "");
    for (const match of content.matchAll(/attachment:\/\/([A-Za-z0-9_-]+)/g)) referencedIds.add(match[1]);
  }
  const missingAttachmentIds = [...referencedIds].filter((id) => !attachmentIds.has(id)).sort();
  const warningCodes = missingAttachmentIds.length ? ["missing-attachment"] : [];
  return {
    version: parsed.version,
    cardCount: data.cards?.length || 0,
    attachmentCount: attachments.length,
    taskCount: data.tasks?.length || 0,
    boardCount: data.boards?.length || 0,
    boardNodeCount: data.boardNodes?.length || 0,
    attachmentReferenceCount: referencedIds.size,
    missingAttachmentIds,
    warningCodes,
    restorable: true,
  };
}

/** Keep names portable across Windows and macOS, including case-insensitive disks. */
export function uniqueArchiveName(title: string, used: Set<string>) {
  const base = title.normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "").slice(0, 90) || "Untitled";
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base;
  let name = safe;
  let suffix = 2;
  while (used.has(name.toLowerCase())) name = `${safe} (${suffix++})`;
  used.add(name.toLowerCase());
  return name;
}
