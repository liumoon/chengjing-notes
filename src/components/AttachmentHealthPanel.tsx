import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Copy, Download, HardDrive, Image, Paperclip, RefreshCw, Search, Trash2 } from "lucide-react";
import { formatBytes } from "../lib/utils";
import { getAttachmentHealthCopy } from "../lib/attachmentHealthCopy";
import { cleanOrphanAttachments, inspectAttachmentHealth, type AttachmentHealthIssue, type AttachmentHealthReport } from "../lib/attachmentHealth";
import { useI18n } from "../hooks/useI18n";
import { attachmentRef } from "../lib/attachmentRefs";
import { attachmentUrl, portableAttachmentBlob, shouldRevokeAttachmentUrl } from "../lib/attachments";
import type { AttachmentRecord, AttachmentRole } from "../types";

type AttachmentFilter = "all" | "issues" | "orphaned" | AttachmentRole;
const MAX_VISIBLE_ENTRIES = 100;

function issueLabel(issue: AttachmentHealthIssue, copy: ReturnType<typeof getAttachmentHealthCopy>) {
  if (issue === "orphan") return copy.orphan;
  if (issue === "missing-blob") return copy.missingBlob;
  if (issue === "missing-path") return copy.missingPath;
  if (issue === "unreadable") return copy.unreadable;
  if (issue === "size-mismatch") return copy.sizeMismatch;
  return copy.invalidSha;
}

function roleOf(attachment: AttachmentRecord): AttachmentRole {
  return attachment.role || "attachment";
}

function AttachmentThumbnail({ attachment }: { attachment: AttachmentRecord }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const isImage = attachment.mime.toLowerCase().startsWith("image/");

  useEffect(() => {
    if (!isImage) {
      setSrc("");
      return;
    }
    const next = attachmentUrl(attachment);
    setSrc(next);
    setFailed(false);
    return () => {
      if (next && shouldRevokeAttachmentUrl(attachment)) URL.revokeObjectURL(next);
    };
  }, [attachment, isImage]);

  if (isImage && src && !failed) {
    return <img className="attachment-health-thumbnail" src={src} alt="" aria-hidden="true" onError={() => setFailed(true)} />;
  }
  return <span className="attachment-health-thumbnail is-placeholder" aria-hidden="true">{isImage ? <Image size={18} /> : <Paperclip size={18} />}</span>;
}

export function AttachmentHealthPanel() {
  const { language } = useI18n();
  const copy = useMemo(() => getAttachmentHealthCopy(language), [language]);
  const [report, setReport] = useState<AttachmentHealthReport | null>(null);
  const [busy, setBusy] = useState<"scan" | "clean" | "">("scan");
  const [filter, setFilter] = useState<AttachmentFilter>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [notice, setNotice] = useState("");

  const scan = useCallback(async () => {
    setBusy("scan");
    try {
      setReport(await inspectAttachmentHealth());
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "attachment-health-failed");
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => { void scan(); }, [scan]);

  const filteredEntries = useMemo(() => {
    if (!report) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return report.entries.filter((entry) => {
      const role = roleOf(entry.attachment);
      const matchesFilter = filter === "all"
        || (filter === "issues" && entry.issues.length > 0)
        || (filter === "orphaned" && entry.issues.includes("orphan"))
        || filter === role;
      if (!matchesFilter) return false;
      if (!normalizedQuery) return true;
      return [entry.attachment.name, entry.attachment.mime, entry.attachment.id, entry.attachment.relativePath || ""]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [filter, query, report]);

  const visibleEntries = filteredEntries.slice(0, MAX_VISIBLE_ENTRIES);

  async function copyReference(entry: AttachmentHealthReport["entries"][number]) {
    const reference = attachmentRef(entry.attachment.id);
    setActionBusy(`${entry.attachment.id}:copy`);
    try {
      if (window.chengjing?.clipboard) {
        await window.chengjing.clipboard.write({ text: reference, payload: { kind: "attachment-ref", attachmentId: entry.attachment.id } });
      } else {
        await navigator.clipboard.writeText(reference);
      }
      setNotice(copy.copiedReference);
    } catch {
      setNotice(copy.copyFailed);
    } finally {
      setActionBusy("");
    }
  }

  async function downloadAttachment(entry: AttachmentHealthReport["entries"][number]) {
    const id = entry.attachment.id;
    if (entry.issues.some((issue) => issue === "missing-blob" || issue === "missing-path" || issue === "unreadable")) {
      setNotice(copy.downloadFailed);
      return;
    }
    setActionBusy(`${id}:download`);
    try {
      const blob = await portableAttachmentBlob(entry.attachment);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = entry.attachment.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice(copy.downloaded(entry.attachment.name));
    } catch {
      setNotice(copy.downloadFailed);
    } finally {
      setActionBusy("");
    }
  }

  async function clean() {
    if (!report?.orphaned || busy) return;
    setBusy("clean");
    try {
      const result = await cleanOrphanAttachments(report);
      setNotice(result.failed.length ? copy.cleanFailed(result.failed.length) : copy.cleanDone(result.removed.length));
      setReport(await inspectAttachmentHealth());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "attachment-cleanup-failed");
    } finally {
      setBusy("");
    }
  }

  const filters: Array<[AttachmentFilter, string]> = [
    ["all", copy.filterAll],
    ["issues", copy.filterIssues],
    ["orphaned", copy.filterOrphaned],
    ["source", copy.filterSource],
    ["inline", copy.filterInline],
    ["attachment", copy.filterAttachment],
  ];

  return (
    <div className="settings-card attachment-health-panel">
      <header>
        <HardDrive size={18} />
        <div><span className="settings-eyebrow">{copy.eyebrow}</span><h3>{copy.title}</h3><p>{copy.description}</p></div>
      </header>
      {report && (
        <>
          <div className="attachment-health-summary">
            <span>{copy.total(report.total)}</span>
            <span>{copy.referenced(report.referenced)}</span>
            <span className={report.orphaned ? "is-warning" : ""}>{copy.orphaned(report.orphaned)}</span>
            <span className={report.issueCount ? "is-warning" : ""}>{copy.issues(report.issueCount)}</span>
            <span>{copy.bytes(formatBytes(report.bytes))}</span>
          </div>
          <div className="attachment-health-toolbar">
            <label className="attachment-health-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} /></label>
            <div className="attachment-health-filters" role="tablist" aria-label={copy.title}>
              {filters.map(([value, label]) => <button type="button" role="tab" aria-selected={filter === value} className={filter === value ? "is-active" : ""} key={value} onClick={() => setFilter(value)}>{label}</button>)}
            </div>
          </div>
          <p className="attachment-health-result-count">{copy.showing(visibleEntries.length, filteredEntries.length)}</p>
          {visibleEntries.length === 0
            ? report.issueCount === 0 && filter === "all" && !query
              ? <p className="attachment-health-empty"><CheckCircle2 size={15} />{copy.empty}</p>
              : <p className="attachment-health-empty">{copy.noMatches}</p>
            : <ul className="attachment-health-list">
              {visibleEntries.map((entry) => {
                const attachment = entry.attachment;
                const role = roleOf(attachment);
                const isExpanded = expandedId === attachment.id;
                const downloadBusy = actionBusy === `${attachment.id}:download`;
                const copyBusy = actionBusy === `${attachment.id}:copy`;
                const unreadable = entry.issues.some((issue) => issue === "missing-blob" || issue === "missing-path" || issue === "unreadable");
                return <li key={attachment.id} className={entry.issues.length ? "has-issues" : ""}>
                  <AttachmentThumbnail attachment={attachment} />
                  <div className="attachment-health-entry-main">
                    <div className="attachment-health-entry-title"><b title={attachment.name}>{attachment.name}</b><span>{copy.role[role]}</span></div>
                    <small>{attachment.mime} · {formatBytes(attachment.size)} · {copy.referenceCount(entry.references)}</small>
                    {entry.issues.length > 0 && <small className="attachment-health-entry-issues"><AlertTriangle size={12} />{entry.issues.map((issue) => issueLabel(issue, copy)).join(" · ")}</small>}
                  </div>
                  <div className="attachment-health-entry-actions">
                    <button type="button" aria-label={copy.copyReference} title={copy.copyReference} disabled={Boolean(actionBusy)} onClick={() => void copyReference(entry)}>{copyBusy ? <RefreshCw size={14} className="spin" /> : <Copy size={14} />}</button>
                    <button type="button" aria-label={copy.download} title={copy.download} disabled={Boolean(actionBusy) || unreadable} onClick={() => void downloadAttachment(entry)}>{downloadBusy ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}</button>
                    <button type="button" aria-label={copy.details} title={copy.details} aria-expanded={isExpanded} onClick={() => setExpandedId(isExpanded ? "" : attachment.id)}>{isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                  </div>
                  {isExpanded && <div className="attachment-health-details">
                    <div><span>{copy.id}</span><code>{attachment.id}</code></div>
                    <div><span>{copy.path}</span><code>{attachment.relativePath || (attachment.storage === "indexeddb" ? copy.storageIndexedDb : copy.storageFile)}</code></div>
                    <div><span>{copy.role[role]}</span><span>{attachment.storage === "file" ? copy.storageFile : copy.storageIndexedDb}</span></div>
                  </div>}
                </li>;
              })}
            </ul>}
          {filteredEntries.length > MAX_VISIBLE_ENTRIES && <p className="attachment-health-result-count">{copy.showing(MAX_VISIBLE_ENTRIES, filteredEntries.length)}</p>}
        </>
      )}
      {notice && <p className="attachment-health-notice" role="status">{notice}</p>}
      <footer className="attachment-health-actions">
        <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void scan()}><RefreshCw size={14} className={busy === "scan" ? "spin" : ""} />{busy === "scan" ? copy.scanning : copy.scan}</button>
        <button type="button" className="danger-text" disabled={!report?.orphaned || Boolean(busy)} onClick={() => void clean()}><Trash2 size={14} />{busy === "clean" ? copy.cleaning : copy.cleanup}</button>
      </footer>
    </div>
  );
}
