import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  FileText,
  FolderTree,
  Highlighter,
  Info,
  Link2,
  MapPin,
  MoreHorizontal,
  PanelsTopLeft,
  Paperclip,
  Pin,
  History,
  Plus,
  Sparkles,
  Tag,
  Trash2,
  Download,
} from "lucide-react";
import { appendCardAttachmentsWithHistory, db, moveCardToTrash, restoreCardVersion, updateCardWithHistory } from "../db";
import { useAppStore } from "../store";
import type { AttachmentRecord, CardRecord } from "../types";
import { localizedKindLabel, relativeTime } from "../lib/utils";
import { CardContentEditor } from "./CardContentEditor";
import { exportCardMarkdown } from "../lib/markdownExport";
import { getImportCopy } from "../lib/importCopy";
import { showContextMenuFromButton } from "../lib/contextMenu";
import { useI18n } from "../hooks/useI18n";
import { TagPicker } from "./TagPicker";
import { KnowledgeGroupPicker } from "./KnowledgeGroupPicker";
import { getCardPropertyCopy } from "../lib/cardPropertyCopy";
import { attachmentUrl, persistAttachment, removeStoredAttachment, shouldRevokeAttachmentUrl } from "../lib/attachments";
import { releaseResolvedUrls } from "../lib/attachmentRefs";
import { openMediaViewer } from "../lib/mediaViewer";
import { persistInlineClipboardImages, rollbackInlineClipboardImages } from "../lib/clipboardImages";
import type { ClipboardImageInput } from "../lib/clipboardImages";
import { searchQueryTerms } from "../lib/searchIndex";
import { isMaterializedCard } from "../lib/journalVisibility";
import { addSelectedAttachmentsToCard, type SelectedAttachmentInput } from "../lib/cardAttachments";
import { getKanbanCopy } from "../lib/kanbanCopy";

const PdfAttachmentViewer = lazy(() => import("./PdfAttachmentViewer").then((module) => ({ default: module.PdfAttachmentViewer })));

function StandardAttachmentPreview({ attachment, downloadLabel, onSaveSvg }: { attachment: AttachmentRecord; downloadLabel: string; onSaveSvg?: (source: string) => Promise<boolean> }) {
  const [url, setUrl] = useState("");
  const [svg, setSvg] = useState("");
  const isSvg = attachment.mime === "image/svg+xml";
  useEffect(() => {
    const next = attachmentUrl(attachment);
    setUrl(next);
    return () => { if (next && shouldRevokeAttachmentUrl(attachment)) releaseResolvedUrls([next]); };
  }, [attachment]);
  // SVG 要拿到原始碼，圖裡的文字才選得起來、也才改得動。
  useEffect(() => {
    if (!isSvg || !url) { setSvg(""); return; }
    let cancelled = false;
    void (async () => {
      try {
        const blob = attachment.blob || (await (await fetch(url)).blob());
        const text = await blob.text();
        if (!cancelled) setSvg(text);
      } catch {
        if (!cancelled) setSvg("");
      }
    })();
    return () => { cancelled = true; };
  }, [attachment, isSvg, url]);
  if (!url) return null;
  const open = () => openMediaViewer({ src: url, alt: attachment.name, attachmentId: attachment.id, svg: svg || undefined, onSaveSvg });
  // Source SVGs stay downloadable as originals; only sanitized inline SVGs are previewed.
  if (isSvg && attachment.role === "source") {
    return <a className="attachment-download" href={url} download={attachment.name}><FileText size={16} />{downloadLabel}</a>;
  }
  if (attachment.mime.startsWith("image/")) return <img className="attachment-image" src={url} alt={attachment.name} role="button" tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }} />;
  if (attachment.mime.startsWith("audio/")) return <audio className="attachment-media" controls src={url} />;
  if (attachment.mime.startsWith("video/")) return <video className="attachment-video" controls src={url} />;
  return <a className="attachment-download" href={url} download={attachment.name}><FileText size={16} />{downloadLabel}</a>;
}

function AttachmentPreview({ attachment, downloadLabel, onRemove, onSaveSvg }: { attachment: AttachmentRecord; downloadLabel: string; onRemove: () => void | Promise<void>; onSaveSvg?: (source: string) => Promise<boolean> }) {
  if (attachment.mime === "application/pdf") return <Suspense fallback={<div className="pdf-document-preview is-loading" aria-label={attachment.name}><span className="pdf-preview-state" /></div>}><PdfAttachmentViewer attachment={attachment} onRemove={onRemove} /></Suspense>;
  return <StandardAttachmentPreview attachment={attachment} downloadLabel={downloadLabel} onSaveSvg={onSaveSvg} />;
}

export function CardEditorPanel() {
  const cardId = useAppStore((state) => state.selectedCardId);
  const view = useAppStore((state) => state.view);
  const close = useAppStore((state) => state.closeCard);
  const openAI = useAppStore((state) => state.openAI);
  const openAIWithAction = useAppStore((state) => state.openAIWithAction);
  const { intlLocale, language, t } = useI18n();
  const card = useLiveQuery(() => cardId ? db.cards.get(cardId) : undefined, [cardId]);
  const attachments = useLiveQuery(async () => card ? (await Promise.all(card.attachmentIds.map((id) => db.attachments.get(id)))).filter(Boolean) as AttachmentRecord[] : [], [card?.attachmentIds.join("|")], []);
  // 卡片頂部只列來源與一般附件；內嵌圖片只出現在正文。
  const headerAttachments = attachments.filter((attachment) => attachment.role !== "inline");
  const locations = useLiveQuery(async () => {
    if (!cardId) return [];
    const nodes = await db.boardNodes.where("cardId").equals(cardId).toArray();
    return (await Promise.all(nodes.map(async (node) => ({ node, board: await db.boards.get(node.boardId) })))).filter((item) => item.board);
  }, [cardId], []);
  const backlinks = useLiveQuery(async () => {
    if (!card?.title) return [];
    const terms = searchQueryTerms(card.title, language);
    const cards = terms.length ? await db.cards.where("searchTerms").anyOf(terms).distinct().limit(500).toArray() : [];
    return cards.filter((item) => item.state !== "trash" && isMaterializedCard(item) && item.id !== card.id && (item.plainText.includes(card.title) || item.contentHtml.includes(`data-card-id=\"${card.id}\"`)));
  }, [card?.id, card?.title, language], []);
  const highlights = useLiveQuery(() => cardId ? db.highlights.where("cardId").equals(cardId).toArray() : [], [cardId], []);
  const versions = useLiveQuery(() => cardId ? db.cardVersions.where("cardId").equals(cardId).reverse().sortBy("createdAt") : [], [cardId], []);
  const [tab, setTab] = useState<"content" | "info">("content");
  const [highlightNotice, setHighlightNotice] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [addingProperty, setAddingProperty] = useState(false);
  const [propertyName, setPropertyName] = useState("");
  const [propertyValue, setPropertyValue] = useState("");
  const [addingAttachments, setAddingAttachments] = useState(false);
  const selectedTextRef = useRef("");
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTitle = useRef<(() => void) | null>(null);
  const titleComposing = useRef(false);
  const propertyCopy = getCardPropertyCopy(language);
  const importCopy = getImportCopy(language);
  const attachmentCopy = getKanbanCopy(language);

  async function exportMarkdown() {
    try {
      const result = await exportCardMarkdown(activeCard, language);
      if (!result.canceled) showHighlightNotice(importCopy.exportMarkdownDone.replace("{name}", result.name));
    } catch {
      showHighlightNotice(importCopy.exportMarkdownFailed);
    }
  }

  useEffect(() => {
    if (!titleComposing.current) setTitleDraft(card?.title || "");
  }, [card?.id, card?.title]);

  useEffect(() => {
    const rememberSelection = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      const anchor = selection?.anchorNode;
      const editorElement = document.querySelector(".card-editor-panel .prose-editor");
      if (!text || !anchor || !editorElement) return;
      const anchorElement = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor as Element;
      if (anchorElement && editorElement.contains(anchorElement)) selectedTextRef.current = text;
    };
    document.addEventListener("selectionchange", rememberSelection);
    return () => document.removeEventListener("selectionchange", rememberSelection);
  }, [cardId]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    pendingTitle.current?.();
  }, []);
  useEffect(() => {
    const flush = () => { if(titleTimer.current)clearTimeout(titleTimer.current);pendingTitle.current?.(); };
    window.addEventListener("chengjing:flush-editors",flush);
    return () => {flush();window.removeEventListener("chengjing:flush-editors",flush);};
  }, [cardId]);

  if (!card) return <div className="panel-loading">{t("card.loading")}</div>;
  const activeCard = card;

  async function update(patch: Partial<CardRecord>) {
    await updateCardWithHistory(activeCard.id, patch);
  }

  /** SVG 編輯後存成「新的一份附件」，原檔留在卡片上隨時拿得回來。 */
  async function saveSvgVersion(attachment: AttachmentRecord, source: string) {
    try {
      const stem = attachment.name.replace(/\.svg$/i, "") || "svg";
      const blob = new Blob([source], { type: "image/svg+xml" });
      const created = await persistAttachment(`${stem}-edited.svg`, blob, "image/svg+xml", undefined, attachment.role || "inline");
      await appendCardAttachmentsWithHistory(activeCard.id, [created.id]);
      return true;
    } catch {
      return false;
    }
  }
  async function detachAttachment(attachment: AttachmentRecord) {
    await update({ attachmentIds: activeCard.attachmentIds.filter((id) => id !== attachment.id) });
    const usedElsewhere = await db.cards.filter((item) => item.id !== activeCard.id && item.attachmentIds.includes(attachment.id)).count();
    if (!usedElsewhere) await removeStoredAttachment(attachment);
  }

  async function addAttachments(inputs: SelectedAttachmentInput[]) {
    if (!inputs.length || addingAttachments) return;
    setAddingAttachments(true);
    try {
      const result = await addSelectedAttachmentsToCard(activeCard.id, inputs);
      if (result.attachments.length && !result.failures.length) {
        showHighlightNotice(attachmentCopy.attachmentAdded);
      } else if (result.failures.length) {
        showHighlightNotice(attachmentCopy.attachmentFailed);
      }
    } catch {
      showHighlightNotice(attachmentCopy.attachmentFailed);
    } finally {
      setAddingAttachments(false);
    }
  }

  async function pasteAttachments(inputs: SelectedAttachmentInput[]) {
    const result = await addSelectedAttachmentsToCard(activeCard.id, inputs);
    if (result.failures.length) showHighlightNotice(attachmentCopy.attachmentFailed);
    if (!result.attachments.length && result.failures.length) throw new Error("clipboard-attachment-failed");
    return result.attachments;
  }

  async function chooseAttachments() {
    if (addingAttachments) return;
    if (!window.chengjing?.files) {
      attachmentInputRef.current?.click();
      return;
    }
    try {
      const result = await window.chengjing.files.open({
        title: attachmentCopy.addAttachment,
        multiple: true,
        metadataOnly: true,
        filters: [{ name: attachmentCopy.attachments, extensions: ["*"] }],
      });
      if (!result.canceled) await addAttachments(result.files);
    } catch {
      showHighlightNotice(attachmentCopy.attachmentFailed);
    }
  }

  function onAttachmentInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.currentTarget.files || [])].map((file) => ({ name: file.name, blob: file }));
    event.currentTarget.value = "";
    void addAttachments(files);
  }

  function saveTitle(value: string, immediate = false) {
    const nextTitle = value || t("common.untitledCard");
    if (titleTimer.current) clearTimeout(titleTimer.current);
    pendingTitle.current = () => {pendingTitle.current=null;void updateCardWithHistory(activeCard.id, { title: nextTitle });};
    if (immediate) pendingTitle.current();
    else titleTimer.current = setTimeout(() => pendingTitle.current?.(), 280);
  }

  function showHighlightNotice(message: string) {
    setHighlightNotice(message);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightNotice(""), 2400);
  }

  async function createHighlight(text: string) {
    const cleanText = text.trim();
    if (!cleanText) return;
    const existing = await db.highlights.where("cardId").equals(activeCard.id).filter((item) => item.text === cleanText).first();
    if (existing) {
      showHighlightNotice(t("card.highlightExists"));
      return;
    }
    await db.highlights.add({ id: crypto.randomUUID(), cardId: activeCard.id, text: cleanText, note: "", color: "amber", createdAt: Date.now() });
    selectedTextRef.current = "";
    showHighlightNotice(t("card.highlightAdded"));
  }

  async function captureHighlight() {
    const text = window.getSelection()?.toString().trim() || selectedTextRef.current;
    if (!text) {
      window.alert(t("card.selectHighlight"));
      return;
    }
    await createHighlight(text);
  }

  async function addProperty(event: React.FormEvent) {
    event.preventDefault();
    const name = propertyName.trim();
    if (!name) return;
    if (Object.prototype.hasOwnProperty.call(activeCard.properties, name)) { showHighlightNotice(propertyCopy.exists); return; }
    await update({ properties: { ...activeCard.properties, [name]: propertyValue.trim() } });
    setPropertyName(""); setPropertyValue(""); setAddingProperty(false); showHighlightNotice(propertyCopy.added);
  }

  async function removeProperty(name: string) {
    const next = { ...activeCard.properties };
    delete next[name];
    await update({ properties: next });
  }

  return (
    <div className="card-editor-panel">
      <header className="panel-header">
        <div className="card-focus-heading"><button type="button" className="card-back-button" onClick={close}><ArrowLeft size={15} /><span>{view === "kanban" ? t("nav.kanban") : view === "boards" ? t("nav.boards") : t("card.backToLibrary")}</span></button><div className="panel-breadcrumb"><span>{localizedKindLabel(card.kind, language)}</span><i /> <span>{card.state === "inbox" ? t("card.inbox") : card.state === "archived" ? t("card.archive") : card.state === "trash" ? t("card.trash") : t("card.library")}</span></div></div>
        <div>
          <button type="button" className="icon-button" onClick={captureHighlight} aria-label={t("card.captureHighlight")} title={t("card.captureHighlight")}><Highlighter size={16} /></button>
          <button type="button" className={card.favorite ? "icon-button is-active" : "icon-button"} onClick={() => update({ favorite: !card.favorite })} aria-label={card.favorite ? t("card.unpin") : t("card.pin")} title={card.favorite ? t("card.unpin") : t("card.pin")}><Pin size={16} fill={card.favorite ? "currentColor" : "none"} /></button>
          <button type="button" className="icon-button" aria-label={importCopy.exportMarkdown} title={importCopy.exportMarkdown} onClick={() => void exportMarkdown()}><Download size={16} /></button>
          <button type="button" className="icon-button" data-card-menu-trigger aria-label={t("card.more")} title={t("card.more")} onClick={(event) => showContextMenuFromButton(event, { kind: "card", id: card.id })}><MoreHorizontal size={17} /></button>
        </div>
      </header>
      <div className="panel-tabs"><button type="button" className={tab === "content" ? "is-active" : ""} onClick={() => setTab("content")}><FileText size={14} />{t("card.content")}</button><button type="button" className={tab === "info" ? "is-active" : ""} onClick={() => setTab("info")}><Info size={14} />{t("card.info")}</button></div>
      {highlightNotice && <div className="card-highlight-notice" role="status"><Highlighter size={14} /><span>{highlightNotice}</span></div>}

      {tab === "content" ? (
        <div className="card-panel-content">
          <input className="card-title-input" value={titleDraft} onChange={(event) => { const value = event.target.value; setTitleDraft(value); if (!titleComposing.current && !(event.nativeEvent as InputEvent).isComposing) saveTitle(value); }} onCompositionStart={() => { titleComposing.current = true; if (titleTimer.current) clearTimeout(titleTimer.current); }} onCompositionEnd={(event) => { titleComposing.current = false; const value = event.currentTarget.value; setTitleDraft(value); saveTitle(value, true); }} onBlur={() => { if (!titleComposing.current) saveTitle(titleDraft, true); }} onKeyDown={(event) => { if (event.key === "Enter" && !(event.nativeEvent as KeyboardEvent).isComposing) event.currentTarget.blur(); }} placeholder={t("common.untitledCard")} />
          <div className="card-meta-line">
            <TagPicker selectedIds={card.tagIds} onChange={(tagIds) => update({ tagIds })} />
            <span>{relativeTime(card.updatedAt, language)}</span>
          </div>
          <div className="card-attachments-toolbar">
            <span><Paperclip size={14} />{attachmentCopy.attachments}{headerAttachments.length ? ` · ${headerAttachments.length}` : ""}</span>
            <button type="button" className="secondary-button" disabled={addingAttachments} onClick={() => void chooseAttachments()}>
              <Plus size={14} />{attachmentCopy.addAttachment}
            </button>
            <input ref={attachmentInputRef} className="sr-only" type="file" multiple onChange={onAttachmentInputChange} />
          </div>
          {headerAttachments.map((attachment) => <AttachmentPreview key={attachment.id} attachment={attachment} downloadLabel={t("card.download", { name: attachment.name })} onRemove={() => detachAttachment(attachment)} onSaveSvg={(source) => saveSvgVersion(attachment, source)} />)}
          {card.sourceUrl && <a className="source-link" href={card.sourceUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={14} /><span>{t("card.source")}</span><code>{new URL(card.sourceUrl).hostname}</code></a>}
          <CardContentEditor contentHtml={card.contentHtml} onChange={(contentHtml, plainText) => update({ contentHtml, plainText })} onHighlight={createHighlight} taskOwnerId={card.id} attachments={attachments} onPasteImages={(inputs: ClipboardImageInput[]) => persistInlineClipboardImages(activeCard.id, inputs)} onPasteImagesRollback={(saved) => rollbackInlineClipboardImages(activeCard.id, saved)} onPasteAttachments={pasteAttachments} />
        </div>
      ) : (
        <div className="card-info-panel">
          <section className="card-knowledge-section"><header><FolderTree size={15} /><span>{t("library.categories")}</span></header><KnowledgeGroupPicker value={card.collectionId} onChange={(collectionId) => update({ collectionId })} /></section>
          <section><header><MapPin size={15} /><span>{t("card.locations")}</span><b>{locations.length}</b></header>{locations.map(({ board }) => <button type="button" key={board!.id} onClick={() => useAppStore.getState().openBoard(board!.id)}><i /><span>{board!.title}</span><ArrowUpRight size={13} /></button>)}{locations.length === 0 && <p>{t("card.noLocations")}</p>}</section>
          <section><header><Link2 size={15} /><span>{t("card.backlinks")}</span><b>{backlinks.length}</b></header>{backlinks.map((item) => <button type="button" key={item.id} onClick={() => useAppStore.getState().openCard(item.id)}><i /><span>{item.title}</span><ArrowUpRight size={13} /></button>)}{backlinks.length === 0 && <p>{t("card.noBacklinks")}</p>}</section>
          <section><header><Highlighter size={15} /><span>{t("card.sourceHighlights")}</span><b>{highlights.length}</b></header>{highlights.map((item) => <blockquote key={item.id}>{item.text}</blockquote>)}{highlights.length === 0 && <p>{t("card.noHighlights")}</p>}</section>
          <section className="version-section"><header><History size={15} /><span>{t("card.versions")}</span><b>{versions.length}</b></header>{versions.slice(0, 8).map((version) => <button type="button" key={version.id} onClick={() => restoreCardVersion(version.id)}><i /><span>{new Intl.DateTimeFormat(intlLocale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(version.createdAt)}</span><small>{t("card.restore")}</small></button>)}{versions.length === 0 && <p>{t("card.noVersions")}</p>}</section>
          <section className="property-section"><header><Tag size={15} /><span>{t("card.properties")}</span></header>{Object.entries(card.properties).map(([key, value]) => <div className="property-row" key={key}><span>{key}</span><input aria-label={key} value={Array.isArray(value) ? value.join("、") : String(value ?? "")} onChange={(event) => update({ properties: { ...card.properties, [key]: event.target.value } })} /><button type="button" aria-label={`${propertyCopy.remove}：${key}`} title={propertyCopy.remove} onClick={() => void removeProperty(key)}><Trash2 size={13} /></button></div>)}{addingProperty ? <form className="property-add-form" onSubmit={addProperty}><input autoFocus aria-label={propertyCopy.name} value={propertyName} onChange={(event) => setPropertyName(event.target.value)} placeholder={propertyCopy.name} /><input aria-label={propertyCopy.value} value={propertyValue} onChange={(event) => setPropertyValue(event.target.value)} placeholder={propertyCopy.value} /><footer><button type="button" onClick={() => { setAddingProperty(false); setPropertyName(""); setPropertyValue(""); }}>{t("common.cancel")}</button><button type="submit" disabled={!propertyName.trim()}>{t("common.save")}</button></footer></form> : <button type="button" className="text-button" onClick={() => setAddingProperty(true)}><Plus size={13} />{t("card.addProperty")}</button>}</section>
          <section className="danger-zone">
            <button type="button" onClick={() => update({ state: card.state === "archived" ? "active" : "archived" })}><Archive size={15} />{card.state === "archived" ? t("card.moveLibrary") : t("card.moveArchive")}</button>
            <button type="button" className="danger-text" data-card-trash onClick={async () => { await moveCardToTrash(card.id); close(); }}><Trash2 size={15} />{t("card.moveTrash")}</button>
          </section>
        </div>
      )}

      <footer className="card-panel-footer">
        {card.state === "inbox" ? <button type="button" className="secondary-button" onClick={() => update({ state: "active" })}><Check size={15} />{t("card.organized")}</button> : <span>{t("card.savedLocal")}</span>}
        <div className="ai-actions">
          <button type="button" className="secondary-button card-convert-board" onClick={() => openAIWithAction(t("card.convertToBoardPrompt"))}><PanelsTopLeft size={15} />{t("card.convertToBoard")}</button>
          <button type="button" className="ai-button" onClick={openAI}><Sparkles size={15} />{t("card.aiAction")}<ChevronDown size={13} /></button>
        </div>
      </footer>
    </div>
  );
}
