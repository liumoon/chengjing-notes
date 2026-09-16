import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Maximize2, Minus, Pencil, Plus, X } from "lucide-react";
import { useI18n } from "../hooks/useI18n";
import { getImportCopy } from "../lib/importCopy";
import { MEDIA_VIEWER_EVENT, type MediaViewerRequest } from "../lib/mediaViewer";
import { attachZoomWheel, clampEditorZoom, editorZoomPercent, nextEditorZoom } from "../lib/editorZoom";
import { sanitizeSvg, svgTextContent } from "../lib/svgSanitize";

/**
 * 全域圖片放大檢視。
 *
 * 正文雙擊、Markdown 預覽、附件縮圖與右鍵選單都走到這裡：
 * 支援縮放、拖曳平移、符合視窗／原始尺寸、透明棋盤背景與 Escape 關閉。
 * SVG 走內嵌渲染，圖裡的文字才選得起來、也才改得動；
 * 存檔是新增一份附件，原檔永遠還在。
 */
export function MediaViewer() {
  const { language } = useI18n();
  const copy = getImportCopy(language);
  const [request, setRequest] = useState<MediaViewerRequest | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<"saved" | "failed" | "copied" | "no-text" | "">("");
  const drag = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null);
  const pinch = useRef<number | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;
  useEffect(() => attachZoomWheel(rootRef.current, (direction) => {
    if (editingRef.current) return;
    setFit(false);
    setZoom((value) => nextEditorZoom(value, direction));
  }), []);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<MediaViewerRequest>).detail;
      if (!detail?.src) return;
      setRequest(detail);
      setZoom(1);
      setFit(true);
      setOffset({ x: 0, y: 0 });
      setEditing(false);
      setDraft(detail.svg || "");
      setNotice("");
    };
    window.addEventListener(MEDIA_VIEWER_EVENT, open);
    return () => window.removeEventListener(MEDIA_VIEWER_EVENT, open);
  }, []);

  const close = useCallback(() => {
    setRequest(null);
    setOffset({ x: 0, y: 0 });
    setEditing(false);
    setNotice("");
  }, []);

  function flash(kind: "saved" | "failed" | "copied" | "no-text") {
    setNotice(kind);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2400);
  }

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (editing) return;
      if (event.key === "+" || event.key === "=") { setFit(false); setZoom((value) => nextEditorZoom(value, 1)); }
      if (event.key === "-") { setFit(false); setZoom((value) => nextEditorZoom(value, -1)); }
      if (event.key === "0") { setZoom(1); setFit(true); setOffset({ x: 0, y: 0 }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, editing, close]);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const sanitized = useMemo(() => (request?.svg ? sanitizeSvg(request.svg)?.svg || "" : ""), [request?.svg]);
  const previewSvg = useMemo(() => (editing ? sanitizeSvg(draft)?.svg || "" : sanitized), [editing, draft, sanitized]);
  const scale = fit ? 1 : clampEditorZoom(zoom);
  const transform = `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`;

  if (!request) return null;

  async function copyText(value: string, kind: "copied" | "no-text") {
    if (!value) { flash("no-text"); return; }
    try {
      await navigator.clipboard?.writeText(value);
      flash(kind);
    } catch {
      flash("no-text");
    }
  }

  async function saveDraft() {
    const sanitizedDraft = sanitizeSvg(draft);
    if (!sanitizedDraft) { flash("failed"); return; }
    const ok = await request?.onSaveSvg?.(sanitizedDraft.svg);
    flash(ok ? "saved" : "failed");
    if (ok) {
      setEditing(false);
      setRequest(request ? { ...request, svg: sanitizedDraft.svg } : request);
    }
  }

  const noticeText = notice === "saved" ? copy.svgSaved : notice === "failed" ? copy.svgSaveFailed : notice === "copied" ? copy.svgCopied : notice === "no-text" ? copy.svgNoText : "";

  return (
    <div
      className="media-viewer"
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={request.alt || copy.mediaViewerTitle}
      onPointerDown={(event) => {
        if (editing || scale === 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, baseX: offset.x, baseY: offset.y };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        setOffset({ x: drag.current.baseX + event.clientX - drag.current.x, y: drag.current.baseY + event.clientY - drag.current.y });
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onTouchMove={(event) => {
        if (event.touches.length !== 2 || editing) return;
        const distance = Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
        if (pinch.current === null) { pinch.current = distance; return; }
        const ratio = distance / pinch.current;
        pinch.current = distance;
        setFit(false);
        setZoom((value) => clampEditorZoom(value * ratio));
      }}
      onTouchEnd={() => { pinch.current = null; }}
    >
      <div className="media-viewer-backdrop" onClick={close} />
      <header className="media-viewer-bar">
        <span className="media-viewer-name">{request.alt || copy.mediaViewerTitle}</span>
        <div className="media-viewer-tools">
          {noticeText && <span role="status" className={`media-viewer-notice ${notice}`}>{noticeText}</span>}
          {request.svg ? <button type="button" aria-label={copy.svgCopyText} title={copy.svgCopyText} onClick={() => void copyText(svgTextContent(request.svg || ""), "copied")}><Copy size={15} /></button> : null}
          {request.svg ? <button type="button" className={editing ? "is-active" : ""} aria-label={copy.svgEdit} title={copy.svgEdit} onClick={() => setEditing((value) => !value)}><Pencil size={15} /></button> : null}
          {editing ? <button type="button" className="is-active" aria-label={copy.svgSave} title={copy.svgSave} onClick={() => void saveDraft()}><Check size={15} /></button> : null}
          <span role="status">{editorZoomPercent(scale)}</span>
          <button type="button" aria-label={copy.mediaViewerZoomOut} title={copy.mediaViewerZoomOut} disabled={editing} onClick={() => { setFit(false); setZoom((value) => nextEditorZoom(value, -1)); }}><Minus size={15} /></button>
          <button type="button" aria-label={copy.mediaViewerZoomIn} title={copy.mediaViewerZoomIn} disabled={editing} onClick={() => { setFit(false); setZoom((value) => nextEditorZoom(value, 1)); }}><Plus size={15} /></button>
          <button type="button" className={fit ? "is-active" : ""} aria-label={copy.mediaViewerFit} title={copy.mediaViewerFit} disabled={editing} onClick={() => { setFit(true); setOffset({ x: 0, y: 0 }); }}><Maximize2 size={15} /></button>
          <a href={request.src} download={request.alt || "image"} aria-label={copy.mediaViewerDownload} title={copy.mediaViewerDownload}><Download size={15} /></a>
          <button type="button" aria-label={copy.mediaViewerClose} title={copy.mediaViewerClose} onClick={close}><X size={16} /></button>
        </div>
      </header>
      <div className="media-viewer-stage" data-editing={String(editing)}>
        {editing ? (
          <div className="media-viewer-editor">
            <textarea
              className="media-viewer-source"
              value={draft}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={copy.svgEditTitle}
            />
            <div className="media-viewer-svg is-preview" dangerouslySetInnerHTML={{ __html: previewSvg || `<p class="media-viewer-empty">${copy.svgInvalid}</p>` }} />
          </div>
        ) : sanitized ? (
          <div className="media-viewer-svg" style={{ transform }} dangerouslySetInnerHTML={{ __html: sanitized }} />
        ) : (
          <img
            src={request.src}
            alt={request.alt || ""}
            draggable={false}
            style={{ transform }}
            onDoubleClick={() => { setFit((value) => !value); setOffset({ x: 0, y: 0 }); }}
          />
        )}
      </div>
    </div>
  );
}
