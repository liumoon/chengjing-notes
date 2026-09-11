import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Check, FileText, FolderOpen, Globe2, LoaderCircle, Upload, X } from "lucide-react";
import { importDocuments, scanDocument, describeWarning, type ImportFileInput, type ImportOutcome, type ImportProgress } from "../lib/importPipeline";
import { getImportCopy } from "../lib/importCopy";
import { dataUrlToBlob } from "../lib/utils";
import { useI18n } from "../hooks/useI18n";
import { useAppStore } from "../store";

/**
 * 共用的匯入流程：真正拖放、逐檔進度、警告與部分成功。
 * 「匯入」視窗、統一新增視窗與白板都掛同一個 Workbench，
 * 因此三處的行為與文案不會分岔。
 */
export interface ImportWorkbenchProps {
  compact?: boolean;
  onImported?: (count: number) => void;
}

interface RowState {
  name: string;
  stage: ImportProgress["stage"] | "queued";
  outcome?: ImportOutcome;
}

function inputsFromFiles(files: File[]) {
  return files.map((file) => ({ name: file.name, blob: file, sourcePath: (file as File & { path?: string }).path }));
}

function inputsFromBridge(files: Array<{ name: string; path: string; data?: string }>): ImportFileInput[] {
  return files.map((file) => ({
    name: file.name,
    // 桌面橋接在 metadataOnly 時只給路徑，内容由匯入器自行從本機取回。
    blob: file.data ? dataUrlToBlob(`data:application/octet-stream;base64,${file.data}`) : new Blob([], { type: "application/octet-stream" }),
    sourcePath: file.path,
  }));
}

export function ImportWorkbench({ compact = false, onImported }: ImportWorkbenchProps) {
  const { language } = useI18n();
  const copy = getImportCopy(language);
  const openCard = useAppStore((state) => state.openCard);
  const [rows, setRows] = useState<RowState[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [consent, setConsent] = useState<{ hosts: string[]; count: number; inputs: ImportFileInput[] } | null>(null);
  const depth = useRef(0);

  const run = useCallback(async (inputs: ImportFileInput[]) => {
    if (!inputs.length) return;
    setBusy(true);
    setRows(inputs.map((input) => ({ name: input.name, stage: "queued" })));
    // 先掃描，把網路圖片的來源網域攤在使用者面前，預設不連線。
    const scans = await Promise.all(inputs.map((input) => scanDocument(input)));
    const hosts = [...new Set(scans.flatMap((scan) => scan.remoteImages.map((url) => { try { return new URL(url).hostname; } catch { return ""; } }).filter(Boolean)))];
    const remoteCount = new Set(scans.flatMap((scan) => scan.remoteImages)).size;
    if (remoteCount > 0) {
      setBusy(false);
      setConsent({ hosts, count: remoteCount, inputs });
      return;
    }
    await commit(inputs, false);
  }, []);

  async function commit(inputs: ImportFileInput[], allowRemoteImages: boolean) {
    setConsent(null);
    setBusy(true);
    setRows(inputs.map((input) => ({ name: input.name, stage: "queued" })));
    const result = await importDocuments(inputs, {
      language,
      allowRemoteImages,
      onProgress: (progress) => setRows((current) => current.map((row, index) => (index === progress.index ? { ...row, stage: progress.stage } : row))),
    });
    setRows(inputs.map((input, index) => ({ name: input.name, stage: result.outcomes[index]?.ok ? "done" : "failed", outcome: result.outcomes[index] })));
    setBusy(false);
    if (result.cards.length === 1) onImported?.(1);
    if (result.cards.length === 1) openCard(result.cards[0].id);
  }

  async function chooseFiles() {
    if (!window.chengjing?.files) {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => void run(inputsFromFiles([...(input.files || [])]));
      input.click();
      return;
    }
    const result = await window.chengjing.files.open({
      title: copy.importTitle,
      multiple: true,
      metadataOnly: true,
      filters: [
        { name: copy.importTitle, extensions: ["pdf", "md", "markdown", "txt", "html", "htm", "docx", "png", "jpg", "jpeg", "webp", "gif", "mp3", "m4a", "wav", "mp4", "mov", "webm"] },
        { name: "*", extensions: ["*"] },
      ],
    });
    if (!result.canceled) await run(inputsFromBridge(result.files));
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    depth.current = 0;
    setDragging(false);
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) void run(inputsFromFiles(files));
  }

  const done = rows.filter((row) => row.stage === "done").length;
  const failed = rows.filter((row) => row.stage === "failed").length;

  return (
    <div className={`import-workbench ${compact ? "is-compact" : ""}`} data-dragging={dragging ? "true" : "false"}>
      <div
        className="import-drop-zone"
        onDragEnter={(event) => { event.preventDefault(); depth.current += 1; setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(event) => { event.preventDefault(); depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); }}
        onDrop={onDrop}
      >
        <Upload size={26} />
        <h3>{copy.importTitle}</h3>
        <p>{copy.importDropHint}</p>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void chooseFiles()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}{copy.importChooseFiles}
        </button>
      </div>

      {consent && (
        <section className="import-consent" role="group" aria-label={copy.remoteConsentTitle}>
          <header><Globe2 size={15} /><b>{copy.remoteConsentTitle}</b></header>
          <p>{copy.remoteConsentBody.replace("{count}", String(consent.count))}</p>
          <div className="import-hosts"><span>{copy.remoteHosts}</span>{consent.hosts.map((host) => <code key={host}>{host}</code>)}</div>
          <footer>
            <button type="button" className="secondary-button" onClick={() => void commit(consent.inputs, false)}>{copy.remoteConsentKeep}</button>
            <button type="button" className="primary-button" onClick={() => void commit(consent.inputs, true)}>{copy.remoteConsentAllow}</button>
          </footer>
        </section>
      )}

      {rows.length > 0 && (
        <section className="import-results" aria-label={copy.importSummary}>
          <header>
            <b>{copy.importSummary}</b>
            <span role="status">{busy ? copy.importProgress.replace("{done}", String(done + failed)).replace("{total}", String(rows.length)) : `${copy.importSucceeded} ${done}${failed ? ` / ${copy.importFailed} ${failed}` : ""}`}</span>
          </header>
          <ul>
            {rows.map((row) => (
              <li key={row.name} className={`is-${row.stage}`}>
                <span className="import-row-icon">
                  {row.stage === "done" ? <Check size={14} /> : row.stage === "failed" ? <X size={14} /> : <LoaderCircle size={14} className={row.stage === "queued" ? "" : "spin"} />}
                </span>
                <span className="import-row-name"><FileText size={13} />{row.name}</span>
                {row.outcome?.ok && row.outcome.card && <button type="button" className="text-button" onClick={() => openCard(row.outcome!.card!.id)}>{copy.importOpenCard}</button>}
                {row.outcome && !row.outcome.ok && <span className="import-row-error" title={row.outcome.error}>{row.outcome.error}</span>}
                {(row.outcome?.warnings || []).length > 0 && (
                  <span className="import-row-warnings"><AlertTriangle size={13} aria-label={copy.warningUnsupported} />{(row.outcome!.warnings || []).slice(0, 2).map((code) => <em key={code}>{describeWarning(language, code)}</em>)}</span>
                )}
              </li>
            ))}
          </ul>
          {!busy && done > 1 && <p className="import-summary-line">{copy.importDone.replace("{count}", String(done))}</p>}
          {!busy && done > 0 && failed > 0 && <p className="import-summary-line">{copy.importPartial.replace("{done}", String(done)).replace("{failed}", String(failed))}</p>}
          {!busy && !done && failed > 0 && <p className="import-summary-line is-error">{copy.importFailedAll}</p>}
        </section>
      )}
    </div>
  );
}
