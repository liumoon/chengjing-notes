import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { formatBytes } from "../lib/utils";
import { getAttachmentHealthCopy } from "../lib/attachmentHealthCopy";
import { cleanOrphanAttachments, inspectAttachmentHealth, type AttachmentHealthIssue, type AttachmentHealthReport } from "../lib/attachmentHealth";
import { useI18n } from "../hooks/useI18n";

function issueLabel(issue: AttachmentHealthIssue, copy: ReturnType<typeof getAttachmentHealthCopy>) {
  if (issue === "orphan") return copy.orphan;
  if (issue === "missing-blob") return copy.missingBlob;
  if (issue === "missing-path") return copy.missingPath;
  if (issue === "unreadable") return copy.unreadable;
  if (issue === "size-mismatch") return copy.sizeMismatch;
  return copy.invalidSha;
}

export function AttachmentHealthPanel() {
  const { language } = useI18n();
  const copy = useMemo(() => getAttachmentHealthCopy(language), [language]);
  const [report, setReport] = useState<AttachmentHealthReport | null>(null);
  const [busy, setBusy] = useState<"scan" | "clean" | "">("scan");
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
          {report.issueCount === 0
            ? <p className="attachment-health-empty"><CheckCircle2 size={15} />{copy.empty}</p>
            : <ul className="attachment-health-list">
              {report.entries.filter((entry) => entry.issues.length).slice(0, 12).map((entry) => (
                <li key={entry.attachment.id}>
                  <AlertTriangle size={14} />
                  <span><b>{entry.attachment.name}</b><small>{entry.issues.map((issue) => issueLabel(issue, copy)).join(" · ")}</small></span>
                </li>
              ))}
            </ul>}
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
