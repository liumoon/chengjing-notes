import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, FileArchive, FileText, Globe2, Link2, LoaderCircle, Upload, X } from "lucide-react";
import { useAppStore } from "../store";
import { useI18n } from "../hooks/useI18n";
import { importWebUrl } from "../lib/importers";
import { ImportWorkbench } from "./ImportWorkbench";
import { restoreLocalBackup, saveJsonBackup, saveMarkdownArchive } from "../lib/backup";
import { backupInspectionMessage, getBackupInspectionCopy } from "../lib/backupInspectionCopy";
import { inspectBackup } from "../lib/backupValidation";

export function ImportModal() {
  const { language, t } = useI18n();
  const open = useAppStore((state) => state.importOpen);
  const setOpen = useAppStore((state) => state.setImportOpen);
  const openCard = useAppStore((state) => state.openCard);
  const [tab, setTab] = useState<"url" | "file" | "backup">("url");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function handleUrl(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(t("import.capturing"));
    try {
      const card = await importWebUrl(url);
      setUrl("");
      setStatus(t("import.webSaved"));
      setOpen(false);
      openCard(card.id);
    } catch (error) { setStatus(error instanceof Error ? error.message : t("import.urlFailed")); }
    finally { setBusy(false); }
  }

  // 檔案匯入改由共用 Workbench 負責：真正拖放、逐檔進度、警告與部分成功。
  const fileImport = <ImportWorkbench onImported={(count) => { setStatus(t("import.filesDone", { count })); if (count === 1) setOpen(false); }} />;

  async function importBackup() {
    if (!window.chengjing) return;
    const result = await window.chengjing.files.open({ title: t("import.backupDialog"), filters: [{ name: t("import.backupFile"), extensions: ["json"] }] });
    if (result.canceled || !result.files[0]) return;
    setBusy(true);
    try {
      const bytes = Uint8Array.from(atob(result.files[0].data), (char) => char.charCodeAt(0));
      const raw = new TextDecoder().decode(bytes);
      const inspection = inspectBackup(JSON.parse(raw));
      const copy = getBackupInspectionCopy(language);
      const summary = [
        `${copy.title}：${copy.version(inspection.version)}`,
        [copy.cards(inspection.cardCount), copy.attachments(inspection.attachmentCount), copy.tasks(inspection.taskCount), copy.boards(inspection.boardCount)].join(" · "),
        backupInspectionMessage(inspection, language),
      ].join("\n");
      setStatus(summary);
      if (!window.confirm(`${summary}\n\n${copy.confirm}`)) return;
      if (!await restoreLocalBackup(raw, result.files[0].path, true)) return;
      setStatus(t("import.backupRestored"));
    } catch (error) { setStatus(error instanceof Error ? error.message : t("import.backupFailed")); }
    finally { setBusy(false); }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
          <motion.section className="modal import-modal" initial={{ opacity: 0, y: 12, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.99 }} onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span>{t("import.eyebrow")}</span><h2>{t("import.title")}</h2></div><button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label={t("common.close")}><X size={18} /></button></header>
            <div className="modal-tabs"><button type="button" className={tab === "url" ? "is-active" : ""} onClick={() => setTab("url")}><Globe2 size={15} />{t("import.url")}</button><button type="button" className={tab === "file" ? "is-active" : ""} onClick={() => setTab("file")}><FileText size={15} />{t("import.file")}</button><button type="button" className={tab === "backup" ? "is-active" : ""} onClick={() => setTab("backup")}><FileArchive size={15} />{t("import.backup")}</button></div>
            <div className="import-body">
              {tab === "url" && <form className="url-import" onSubmit={handleUrl}><div className="import-illustration"><Globe2 size={28} /><i /><i /></div><h3>{t("import.webTitle")}</h3><p>{t("import.webDescription")}</p><label><Link2 size={16} /><input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label><button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{busy ? t("import.capturingShort") : t("import.urlSubmit")}</button></form>}
              {tab === "file" && <div className="file-import">{fileImport}</div>}
              {tab === "backup" && <div className="backup-grid"><button type="button" onClick={saveJsonBackup}><FileArchive size={22} /><span><b>{t("import.jsonBackup")}</b><small>{t("import.jsonDescription")}</small></span><Download size={16} /></button><button type="button" onClick={saveMarkdownArchive}><FileText size={22} /><span><b>{t("import.markdownBackup")}</b><small>{t("import.markdownDescription")}</small></span><Download size={16} /></button><button type="button" onClick={importBackup}><Upload size={22} /><span><b>{t("import.restore")}</b><small>{t("import.restoreDescription")}</small></span><Upload size={16} /></button></div>}
            </div>
            {status && <footer className="modal-status" role="status">{busy && <LoaderCircle size={14} className="spin" />}<span>{status}</span></footer>}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
