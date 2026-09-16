import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Annotation, Compartment, EditorState, StateField, type Extension, type Range as CMRange } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  drawSelection,
  dropCursor,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown as markdownLanguageExtension, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { ChevronDown, ChevronUp, Code, Eye, Search, ZoomIn, ZoomOut } from "lucide-react";
import { useI18n } from "../hooks/useI18n";
import { getImportCopy } from "../lib/importCopy";
import { EDITOR_FLUSH_EVENT } from "../lib/editorMode";
import { attachZoomWheel, editorZoomPercent, nextEditorZoom } from "../lib/editorZoom";
import { blockContains, markdownBlocks, previewOffsetToSource, renderMarkdownBlock } from "../lib/markdownLivePreview";
import { openMediaViewer } from "../lib/mediaViewer";
import { claimClipboardPaste, classifyClipboardPaste, type ClipboardPasteContent } from "../lib/clipboardContent";
import { attachmentRef } from "../lib/attachmentRefs";
import { useAppStore } from "../store";
import type { AttachmentRecord } from "../types";
import { dataImageInput, type ClipboardImageInput } from "../lib/clipboardImages";
import type { SelectedAttachmentInput } from "../lib/cardAttachments";

/**
 * Markdown 模式的編輯器。
 *
 * 用 CodeMirror 6（Obsidian 同一套底）做「即時預覽」：游標所在的區塊顯示
 * 原始碼，其餘區塊渲染成格式與圖片。存庫的仍然只有 `contentHtml`，
 * 這裡只是同一份文件的另一個投影，所以備份、同步與版本協定都不變。
 */
interface MarkdownSourceEditorProps {
  markdown: string;
  onChange: (value: string) => unknown;
  placeholder?: string;
  autoFocus?: boolean;
  taskOwnerId?: string;
  attachments?: AttachmentRecord[];
  onPasteImages?: (inputs: ClipboardImageInput[]) => Promise<AttachmentRecord[]> | AttachmentRecord[];
  onPasteImagesRollback?: (attachments: AttachmentRecord[]) => Promise<void> | void;
  onPasteAttachments?: (inputs: SelectedAttachmentInput[]) => Promise<AttachmentRecord[]> | AttachmentRecord[];
  /** 網路圖片預設不連線；使用者點「下載」提示時才走這裡。 */
  onDownloadRemoteImage?: (url: string) => Promise<AttachmentRecord | null>;
}

const AUTOSAVE_MS = 420;
const PREVIEW_STORAGE_KEY = "chengjing-markdown-preview";

export function readMarkdownPreviewMode(): "live" | "source" {
  try {
    return localStorage.getItem(PREVIEW_STORAGE_KEY) === "source" ? "source" : "live";
  } catch {
    return "live";
  }
}

export function writeMarkdownPreviewMode(mode: "live" | "source") {
  try {
    localStorage.setItem(PREVIEW_STORAGE_KEY, mode);
  } catch {
    /* 沒有 localStorage 的環境就維持當次有效。 */
  }
}

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700", color: "var(--text-1)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent-strong)" },
  { tag: t.url, color: "var(--accent-strong)" },
  { tag: t.monospace, color: "var(--accent-strong)" },
  { tag: t.quote, color: "var(--text-muted)" },
  { tag: t.list, color: "var(--accent-strong)" },
  { tag: t.contentSeparator, color: "var(--border-strong)" },
]);

const previewCache = new Map<string, string>();

function cachedRender(blockText: string, attachments: AttachmentRecord[]) {
  const key = `${attachments.map((attachment) => attachment.id).join(",")}:${blockText}`;
  const hit = previewCache.get(key);
  if (hit !== undefined) return hit;
  const rendered = renderMarkdownBlock(blockText, attachments).html;
  if (previewCache.size > 800) previewCache.clear();
  previewCache.set(key, rendered);
  return rendered;
}

/** 游標不在這裡的區塊渲染成 HTML；點一下就把游標放回原始碼。 */
class PreviewBlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly blockText: string,
    readonly onRemoteImage?: (url: string) => void,
  ) {
    super();
  }

  eq(other: PreviewBlockWidget) {
    return other.html === this.html && other.blockText === this.blockText;
  }

  toDOM(view: EditorView) {
    const host = document.createElement("div");
    host.className = "md-preview-block";
    host.innerHTML = this.html;
    host.addEventListener("mousedown", (event) => {
      const chip = (event.target as HTMLElement).closest<HTMLElement>(".md-remote-chip");
      if (chip) {
        event.preventDefault();
        event.stopPropagation();
        this.onRemoteImage?.(chip.getAttribute("data-remote-url") || "");
        return;
      }
      const image = (event.target as HTMLElement).closest<HTMLImageElement>("img");
      if (image?.getAttribute("src")) {
        event.preventDefault();
        openMediaViewer({ src: image.getAttribute("src") || "", alt: image.getAttribute("alt") || "" });
        return;
      }
      event.preventDefault();
      try {
        const offset = textOffsetIn(host, event.clientX, event.clientY);
        const start = view.posAtDOM(host, 0);
        const target = Math.max(0, Math.min(view.state.doc.length, start + previewOffsetToSource(this.blockText, offset)));
        view.dispatch({ selection: { anchor: target, head: target } });
        view.focus();
      } catch {
        /* 預覽節點可能已經被替換掉；忽略這次點擊就好。 */
      }
    });
    return host;
  }

  ignoreEvent() {
    return false;
  }
}

/** 點預覽時把滑鼠位置換成「看得到的字」的偏移。 */
function textOffsetIn(host: HTMLElement, clientX: number, clientY: number) {
  type PointDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const doc = document as PointDocument;
  let container: Node | null = null;
  let offsetInContainer = 0;
  const fromPoint = doc.caretPositionFromPoint?.(clientX, clientY);
  if (fromPoint) {
    container = fromPoint.offsetNode;
    offsetInContainer = fromPoint.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(clientX, clientY);
    if (range) {
      container = range.startContainer;
      offsetInContainer = range.startOffset;
    }
  }
  if (!container || !host.contains(container)) return 0;
  let counted = 0;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === container) return counted + offsetInContainer;
    counted += node.textContent?.length || 0;
  }
  return counted;
}

interface PreviewOptions {
  attachments: () => AttachmentRecord[];
  onRemoteImage: (url: string) => void;
  composing: () => boolean;
}

/** 附件換了要重算預覽，用這個標記通知 StateField。 */
const PREVIEW_REFRESH = Annotation.define<boolean>();

/**
 * 游標不在這裡的區塊渲染成 HTML，其餘維持原始碼（Obsidian 式的即時預覽）。
 *
 * 注意：CodeMirror 不允許 ViewPlugin 提供「整塊」裝飾（block decoration），
 * 所以即時預覽一定要用 StateField 提供，改成 ViewPlugin 會直接拋錯。
 */
function makePreviewField(options: PreviewOptions) {
  function build(state: EditorState): DecorationSet {
    if (options.composing()) return Decoration.none;
    const source = state.doc.toString();
    const attachments = options.attachments();
    const { from, to } = state.selection.main;
    const ranges: CMRange<Decoration>[] = [];
    for (const block of markdownBlocks(source)) {
      if (blockContains(block, from, to)) continue;
      const html = cachedRender(block.text, attachments);
      if (!html.trim()) continue;
      const widget = new PreviewBlockWidget(html, block.text, options.onRemoteImage);
      ranges.push(Decoration.replace({ widget, block: true }).range(block.from, block.to));
    }
    return Decoration.set(ranges, true);
  }
  return StateField.define<DecorationSet>({
    create: (state) => build(state),
    update: (value, tr) => {
      if (tr.docChanged || tr.selection || tr.annotation(PREVIEW_REFRESH)) return build(tr.state);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

export function MarkdownSourceEditor({
  markdown,
  onChange,
  placeholder,
  autoFocus = false,
  taskOwnerId,
  attachments = [],
  onPasteImages,
  onPasteImagesRollback,
  onPasteAttachments,
  onDownloadRemoteImage,
}: MarkdownSourceEditorProps) {
  const { language } = useI18n();
  const copy = getImportCopy(language);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onPasteImagesRef = useRef(onPasteImages);
  const onPasteImagesRollbackRef = useRef(onPasteImagesRollback);
  const onPasteAttachmentsRef = useRef(onPasteAttachments);
  const onDownloadRef = useRef(onDownloadRemoteImage);
  const taskOwnerIdRef = useRef(taskOwnerId);
  const attachmentsRef = useRef(attachments);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const previewCompartment = useRef(new Compartment()).current;
  const [previewMode, setPreviewMode] = useState<"live" | "source">(() => readMarkdownPreviewMode());
  const previewModeRef = useRef(previewMode);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pasteState, setPasteState] = useState<"idle" | "saving" | "error">("idle");
  const [pasteKind, setPasteKind] = useState<"image" | "attachment">("image");
  const editorZoom = useAppStore((state) => state.editorZoom);
  const setEditorZoom = useAppStore((state) => state.setEditorZoom);
  const editorZoomRef = useRef(editorZoom);
  editorZoomRef.current = editorZoom;
  useEffect(() => attachZoomWheel(hostRef.current, (direction) => setEditorZoom(nextEditorZoom(editorZoomRef.current, direction))), [setEditorZoom]);
  taskOwnerIdRef.current = taskOwnerId;
  previewModeRef.current = previewMode;
  attachmentsRef.current = attachments;

  useEffect(() => {
    onChangeRef.current = onChange;
    onPasteImagesRef.current = onPasteImages;
    onPasteImagesRollbackRef.current = onPasteImagesRollback;
    onPasteAttachmentsRef.current = onPasteAttachments;
    onDownloadRef.current = onDownloadRemoteImage;
  }, [onChange, onPasteImages, onPasteImagesRollback, onPasteAttachments, onDownloadRemoteImage]);

  /** 組字（IME）期間不重排預覽，避免中文輸入被裝飾切掉。 */
  const composingRef = useRef(false);
  const previewFieldRef = useRef<StateField<DecorationSet> | null>(null);
  if (!previewFieldRef.current) {
    previewFieldRef.current = makePreviewField({
      attachments: () => attachmentsRef.current,
      onRemoteImage: (url) => {
        void downloadRemote(url);
      },
      composing: () => composingRef.current,
    });
  }
  const previewExtension = useCallback((): Extension[] => {
    return previewModeRef.current === "live" && previewFieldRef.current ? [previewFieldRef.current] : [];
  }, [previewMode]);

  /**
   * Markdown 裡直接貼上 data URL 圖片時，立刻轉成附件。
   * 卡片只留 `attachment://<id>`，不會把幾 MB 的 base64 塞進 contentHtml。
   */
  const promoting = useRef(false);
  async function promoteDataImages(view: EditorView) {
    if (promoting.current || !onPasteImagesRef.current) return;
    const text = view.state.doc.toString();
    if (!text.includes("data:image")) return;
    const found: Array<{ source: string; alt: string; input: ClipboardImageInput }> = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(/!\[([^\]]*)\]\((data:[^)\s]+)\)/g)) {
      if (seen.has(match[2])) continue;
      seen.add(match[2]);
      const source = match[2];
      const alt = match[1] || "";
      const input = dataImageInput(source, alt);
      if (input) found.push({ source, alt, input });
    }
    if (!found.length) return;
    promoting.current = true;
    if (mounted.current) {
      setPasteKind("image");
      setPasteState("saving");
    }
    let saved: AttachmentRecord[] = [];
    try {
      saved = await Promise.resolve(onPasteImagesRef.current!(found.map((item) => item.input)));
    } catch {
      saved = [];
    }
    if (!mounted.current || viewRef.current !== view) {
      promoting.current = false;
      await Promise.resolve(onPasteImagesRollbackRef.current?.(saved)).catch(() => {});
      return;
    }
    if (!saved.length) {
      promoting.current = false;
      if (mounted.current) setPasteState("error");
      commit(text);
      return;
    }
    // 用「目前的文件」重新定位，只換掉 data URL 本身，
    // 這樣等待附件期間使用者繼續輸入的文字不會被蓋掉，游標也由 CodeMirror 映射。
    const current = view.state.doc.toString();
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    found.forEach((item, index) => {
      const attachment = saved[index];
      if (!attachment) return;
      const ref = attachmentRef(attachment.id);
      let pos = current.indexOf(item.source);
      while (pos >= 0) {
        changes.push({ from: pos, to: pos + item.source.length, insert: ref });
        pos = current.indexOf(item.source, pos + item.source.length);
      }
    });
    promoting.current = false;
    if (mounted.current) setPasteState("idle");
    if (changes.length) view.dispatch({ changes });
    commit(view.state.doc.toString());
  }


  function commit(value: string) {
    if (timer.current) clearTimeout(timer.current);
    pending.current = () => {
      pending.current = null;
      void Promise.resolve().then(() => onChangeRef.current(value));
    };
    // 圖片還在轉附件時先不入庫，等附件就位後再存，避免 base64 進到 contentHtml。
    if (promoting.current) return;
    timer.current = setTimeout(() => pending.current?.(), AUTOSAVE_MS);
  }

  /** 網路圖片只在使用者明確點擊提示時下載，成功後把網址換成附件參考。 */
  async function downloadRemote(url: string) {
    const handler = onDownloadRef.current;
    if (!handler || !url) return;
    const view = viewRef.current;
    if (!view) return;
    setPasteKind("image");
    setPasteState("saving");
    try {
      const saved = await handler(url);
      if (!saved) {
        if (mounted.current) setPasteState("error");
        return;
      }
      if (!mounted.current || viewRef.current !== view) return;
      const source = view.state.doc.toString();
      const next = source.split(url).join(`](attachment://${saved.id})`.slice(2));
      if (next === source) {
        if (mounted.current) setPasteState("idle");
        return;
      }
      const selection = view.state.selection.main;
      view.dispatch({ changes: { from: 0, to: source.length, insert: next }, selection: { anchor: Math.min(selection.anchor, next.length) } });
      commit(next);
      if (mounted.current) setPasteState("idle");
    } catch {
      if (mounted.current) setPasteState("error");
    }
  }

  /**
   * 貼上分流：純文字與格式化內容交給 CodeMirror 原生處理，
   * 只有真的帶有圖片或檔案時才攔下來落地成附件。
   */
  function handlePaste(event: ClipboardEvent) {
    const content = classifyClipboardPaste(event);
    const wantsImages = content.images.length > 0 && Boolean(onPasteImagesRef.current);
    const wantsFiles = content.files.length > 0 && Boolean(onPasteAttachmentsRef.current);
    if (!wantsImages && !wantsFiles) return false;
    if (!claimClipboardPaste(event)) return true;
    event.preventDefault();
    const view = viewRef.current;
    if (!view) return true;
    setPasteKind(content.kind === "file" ? "attachment" : "image");
    setPasteState("saving");
    void runPaste(view, content, wantsImages, wantsFiles);
    return true;
  }

  async function runPaste(view: EditorView, content: ClipboardPasteContent, wantsImages: boolean, wantsFiles: boolean) {
    const pasteOwnerId = taskOwnerIdRef.current;
    const caret = view.state.selection.main.head;
    let attachmentError = false;
    if (wantsFiles) {
      try {
        await Promise.resolve(onPasteAttachmentsRef.current?.(content.files));
      } catch {
        attachmentError = true;
      }
    }
    if (!wantsImages) {
      if (mounted.current) setPasteState(attachmentError ? "error" : "idle");
      return;
    }
    let saved: AttachmentRecord[] = [];
    try {
      saved = await Promise.resolve(onPasteImagesRef.current!(content.images));
    } catch {
      if (mounted.current) setPasteState("error");
      return;
    }
    if (!saved.length) {
      if (mounted.current) setPasteState(attachmentError ? "error" : "idle");
      return;
    }
    if (!mounted.current || viewRef.current !== view || taskOwnerIdRef.current !== pasteOwnerId) {
      await Promise.resolve(onPasteImagesRollbackRef.current?.(saved)).catch(() => {});
      if (mounted.current) setPasteState("error");
      return;
    }
    const inserted = `${content.text.trim() ? `${content.text.trim()}\n\n` : ""}${saved.map((attachment) => `![${attachment.name}](${attachmentRef(attachment.id)})`).join("\n\n")}`;
    const currentCaret = view.state.selection.main.head === caret ? caret : view.state.selection.main.head;
    const before = view.state.doc.sliceString(0, currentCaret);
    const separator = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const change = { from: currentCaret, insert: `${separator}${inserted}\n` };
    view.dispatch({ changes: change, selection: { anchor: currentCaret + separator.length + inserted.length + 1 } });
    commit(view.state.doc.toString());
    if (mounted.current) setPasteState(attachmentError ? "error" : "idle");
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    mounted.current = true;
    const view = new EditorView({
      state: EditorState.create({
        doc: markdown,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, indentWithTab, ...historyKeymap]),
          markdownLanguageExtension({ base: markdownLanguage }),
          syntaxHighlighting(markdownHighlight),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({ "aria-label": copy.modeMarkdown, spellcheck: "false" }),
          EditorView.domEventHandlers({
            paste: (event) => handlePaste(event),
            compositionstart: () => { composingRef.current = true; return false; },
            compositionend: () => { composingRef.current = false; view.dispatch({ annotations: PREVIEW_REFRESH.of(true) }); return false; },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              // 先轉附件再排程存檔，contentHtml 才不會出現一整串 base64。
              void promoteDataImages(update.view);
              commit(update.state.doc.toString());
            }
          }),
          previewCompartment.of(previewExtension()),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => {
      mounted.current = false;
      view.destroy();
      viewRef.current = null;
    };
    // 只建立一次：內容與附件都透過 dispatch 更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === markdown) return;
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: markdown },
      selection: { anchor: Math.min(selection.anchor, markdown.length) },
    });
  }, [markdown]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // 模式切換：掛上／拿下即時預覽用的 StateField。
    view.dispatch({ effects: previewCompartment.reconfigure(previewExtension()) });
  }, [previewMode, previewCompartment, previewExtension]);

  // 附件決定圖片網址，所以附件變動後要重算預覽。
  useEffect(() => {
    viewRef.current?.dispatch({ annotations: PREVIEW_REFRESH.of(true) });
  }, [attachments]);

  useEffect(() => {
    const flush = () => {
      if (timer.current) clearTimeout(timer.current);
      pending.current?.();
    };
    window.addEventListener(EDITOR_FLUSH_EVENT, flush);
    return () => {
      window.removeEventListener(EDITOR_FLUSH_EVENT, flush);
      flush();
    };
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [] as number[];
    const haystack = markdown.toLowerCase();
    const found: number[] = [];
    let cursor = haystack.indexOf(needle);
    while (cursor !== -1 && found.length < 500) {
      found.push(cursor);
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, query]);

  useEffect(() => {
    if (!matches.length) return;
    const view = viewRef.current;
    if (!view) return;
    const index = matches[Math.min(active, matches.length - 1)];
    view.dispatch({
      selection: { anchor: index, head: index + query.trim().length },
      effects: EditorView.scrollIntoView(index, { y: "center" }),
    });
  }, [active, matches, query]);

  function jump(step: number) {
    if (!matches.length) return;
    setActive((value) => (value + step + matches.length) % matches.length);
  }

  return (
    <div
      className="markdown-source-editor"
      data-preview={previewMode}
    >
      <div className="markdown-source-toolbar">
        <label className="markdown-search">
          <Search size={14} />
          <input value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} placeholder={copy.markdownSearch} aria-label={copy.markdownSearch} />
          <span role="status">{query ? (matches.length ? `${Math.min(active + 1, matches.length)}/${matches.length}` : copy.markdownSearchEmpty) : ""}</span>
          <button type="button" aria-label={copy.markdownSearchPrevious} title={copy.markdownSearchPrevious} disabled={!matches.length} onClick={() => jump(-1)}><ChevronUp size={14} /></button>
          <button type="button" aria-label={copy.markdownSearchNext} title={copy.markdownSearchNext} disabled={!matches.length} onClick={() => jump(1)}><ChevronDown size={14} /></button>
        </label>
        <div className="markdown-source-tools">
          <button type="button" className={previewMode === "live" ? "is-active" : ""} aria-pressed={previewMode === "live"} title={previewMode === "live" ? copy.markdownSourceToggle : copy.markdownPreviewToggle} onClick={() => { const next = previewMode === "live" ? "source" : "live"; setPreviewMode(next); writeMarkdownPreviewMode(next); }}>
            {previewMode === "live" ? <Eye size={14} /> : <Code size={14} />}
            <span>{previewMode === "live" ? copy.markdownPreviewToggle : copy.markdownSourceToggle}</span>
          </button>
          <button type="button" aria-label={copy.editorZoomOut} title={copy.editorZoomOut} onClick={() => setEditorZoom(nextEditorZoom(editorZoom, -1))}><ZoomOut size={14} /></button>
          <span role="status">{editorZoomPercent(editorZoom)}</span>
          <button type="button" aria-label={copy.editorZoomIn} title={copy.editorZoomIn} onClick={() => setEditorZoom(nextEditorZoom(editorZoom, 1))}><ZoomIn size={14} /></button>
          {pasteState === "saving" && <span role="status" className="save-state saving">{pasteKind === "attachment" ? copy.pasteAttachmentSaving : copy.pasteImageSaving}</span>}
          {pasteState === "error" && <span role="alert" className="save-state error">{pasteKind === "attachment" ? copy.pasteAttachmentFailed : copy.pasteImageFailed}</span>}
        </div>
      </div>
      <div className="markdown-source-input markdown-codemirror" ref={hostRef}>
        {!markdown.trim() && placeholder ? <div className="markdown-placeholder" aria-hidden="true">{placeholder}</div> : null}
      </div>
      <p className="markdown-preview-hint">{previewMode === "live" ? copy.markdownPreviewHint : copy.markdownTabHint}</p>
    </div>
  );
}
