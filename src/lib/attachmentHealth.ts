import { db } from "../db";
import type { AttachmentRecord, CardRecord, CardVersionRecord } from "../types";
import { removeStoredAttachment } from "./attachments";

export type AttachmentHealthIssue =
  | "orphan"
  | "missing-blob"
  | "missing-path"
  | "unreadable"
  | "size-mismatch"
  | "invalid-sha256";

export interface AttachmentHealthEntry {
  attachment: AttachmentRecord;
  references: number;
  referenceKinds: string[];
  issues: AttachmentHealthIssue[];
}

export interface AttachmentHealthReport {
  checkedAt: number;
  total: number;
  referenced: number;
  orphaned: number;
  issueCount: number;
  bytes: number;
  entries: AttachmentHealthEntry[];
}

export interface AttachmentCleanupResult {
  removed: string[];
  failed: Array<{ id: string; error: string }>;
}

function attachmentIdsInContent(value: string) {
  const ids = new Set<string>();
  const expression = /attachment:\/\/([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value || ""))) ids.add(match[1]);
  return ids;
}

function addReference(references: Map<string, Set<string>>, id: string, kind: string) {
  if (!id) return;
  const kinds = references.get(id) || new Set<string>();
  kinds.add(kind);
  references.set(id, kinds);
}

function base64ByteLength(value: string) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
}

async function checkFileBackedAttachment(attachment: AttachmentRecord, issues: AttachmentHealthIssue[]) {
  if (!attachment.relativePath) {
    issues.push("missing-path");
    return;
  }
  const readData = typeof window !== "undefined" ? window.chengjing?.attachments?.readData : undefined;
  if (!readData) return;
  try {
    const data = await readData(attachment.relativePath);
    if (!data) issues.push("unreadable");
    else if (attachment.size !== base64ByteLength(data)) issues.push("size-mismatch");
  } catch {
    issues.push("unreadable");
  }
}

async function checkAttachment(attachment: AttachmentRecord, referenced: Set<string>, referenceKinds: Set<string>) {
  const issues: AttachmentHealthIssue[] = [];
  if (!referenced.has(attachment.id)) issues.push("orphan");
  if (attachment.sha256 && !/^[a-f0-9]{64}$/i.test(attachment.sha256)) issues.push("invalid-sha256");
  if (attachment.storage === "file") {
    await checkFileBackedAttachment(attachment, issues);
  } else if (!attachment.blob) {
    issues.push("missing-blob");
  } else if (attachment.blob.size !== attachment.size) {
    issues.push("size-mismatch");
  }
  return {
    attachment,
    references: referenceKinds.size,
    referenceKinds: [...referenceKinds].sort(),
    issues,
  };
}

/**
 * Scan attachment references without changing the database.
 *
 * Card versions are included deliberately: a file that is only referenced by
 * Undo/history must not be offered for cleanup.
 */
export async function inspectAttachmentHealth(): Promise<AttachmentHealthReport> {
  const [cards, versions, attachments] = await Promise.all([
    db.cards.toArray(),
    db.cardVersions.toArray(),
    db.attachments.toArray(),
  ]);
  const references = new Map<string, Set<string>>();
  for (const card of cards as CardRecord[]) {
    for (const id of card.attachmentIds || []) addReference(references, id, `card:${card.id}`);
    for (const id of attachmentIdsInContent(card.contentHtml)) addReference(references, id, `content:${card.id}`);
  }
  for (const version of versions as CardVersionRecord[]) {
    for (const id of attachmentIdsInContent(version.contentHtml)) addReference(references, id, `history:${version.cardId}`);
  }
  const entries = await Promise.all(attachments.map((attachment) => checkAttachment(
    attachment,
    new Set(references.keys()),
    references.get(attachment.id) || new Set(),
  )));
  return {
    checkedAt: Date.now(),
    total: entries.length,
    referenced: entries.filter((entry) => entry.references > 0).length,
    orphaned: entries.filter((entry) => entry.issues.includes("orphan")).length,
    issueCount: entries.reduce((count, entry) => count + entry.issues.length, 0),
    bytes: entries.reduce((total, entry) => total + Math.max(0, Number(entry.attachment.size) || 0), 0),
    entries: entries.sort((left, right) => {
      const issueDelta = right.issues.length - left.issues.length;
      return issueDelta || left.attachment.name.localeCompare(right.attachment.name);
    }),
  };
}

/** Remove only records with no current or historical reference. */
export async function cleanOrphanAttachments(report?: AttachmentHealthReport): Promise<AttachmentCleanupResult> {
  const current = report || await inspectAttachmentHealth();
  const removed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const entry of current.entries.filter((item) => item.issues.includes("orphan") && item.references === 0)) {
    try {
      await removeStoredAttachment(entry.attachment);
      removed.push(entry.attachment.id);
    } catch (error) {
      failed.push({ id: entry.attachment.id, error: error instanceof Error ? error.message : "cleanup-failed" });
    }
  }
  return { removed, failed };
}
