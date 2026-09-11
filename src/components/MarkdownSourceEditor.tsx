import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { getImportCopy } from "../lib/importCopy";
import { EDITOR_FLUSH_EVENT } from "../lib/editorMode";
import { clipboardMarkdownForAttachments, extractClipboardImages } from "../lib/clipboardImages";
import type { ClipboardImageInput } from "../lib/clipboardImages";
import type { AttachmentRecord } from "../types";
import { useI18n } from "../hooks/useI18n";

/**
 * Markdown 原始碼模式：輕量等寬文字框。
 *
 * 支援 Tab／Shift+Tab 縮排、IME 組字、卡內搜尋、420ms 自動儲存與
 * 關閉前 flush。組字期間不觸發存檔，避免把未完成的注音／拼音候選
 * 寫進卡片。
 */
const INDENT = "  ";
const AUTOSAVE_MS = 420;

interface MarkdownSourceEditorProps {
  markdown: string;
  onChange: (markdown: string) => unknown;
  placeholder?: string;
  autoFocus?: boolean;
  taskOwnerId?: string;
  onPasteImages?: (inputs: ClipboardImageInput[]) => Promise<AttachmentRecord[]> | AttachmentRecord[];
  onPasteImagesRollback?: (attachments: AttachmentRecord[]) => Promise<void> | void;
}

function indentRange(value: string, start: number, end: number, direction: 1 | -1) {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const sliceEnd = end === start ? (value.indexOf("\n", start) === -1 ? value.length : value.indexOf("\n", start)) : end;
  const block = value.slice(lineStart, sliceEnd);
  if (direction === 1) {
    const next = block.split("\n").map((line) => INDENT + line).join("\n");
    return { value: value.slice(0, lineStart) + next + value.slice(sliceEnd), delta: INDENT.length };
  }
  const lines = block.split("\n");
  const next = lines.map((line) => (line.startsWith(INDENT) ? line.slice(INDENT.length) : line.startsWith(" ") ? line.slice(1) : line)).join("\n");
  return { value: value.slice(0, lineStart) + next + value.slice(sliceEnd), delta: -(block.length - next.length) };
}

export function MarkdownSourceEditor({ markdown, onChange, placeholder, autoFocus = false, taskOwnerId, onPasteImages, onPasteImagesRollback }: MarkdownSourceEditorProps) {
  const { language } = useI18n();
  const copy = getImportCopy(language);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const onPasteImagesRef = useRef(onPasteImages);
  const onPasteImagesRollbackRef = useRef(onPasteImagesRollback);
  const taskOwnerIdRef = useRef(taskOwnerId);
  const mounted = useRef(true);
  const latest = useRef(markdown);
  const [draft, setDraft] = useState(markdown);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pasteState, setPasteState] = useState<"idle" | "saving" | "error">("idle");
  taskOwnerIdRef.current = taskOwnerId;

  useEffect(() => {
    if (composing.current) return;
    latest.current = markdown;
    setDraft(markdown);
  }, [markdown]);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    onPasteImagesRef.current = onPasteImages;
    onPasteImagesRollbackRef.current = onPasteImagesRollback;
  }, [onPasteImages, onPasteImagesRollback]);

  function commit(value: string) {
    latest.current = value;
    if (timer.current) clearTimeout(timer.current);
    pending.current = () => {
      pending.current = null;
      void Promise.resolve().then(() => onChange(latest.current));
    };
    timer.current = setTimeout(() => pending.current?.(), AUTOSAVE_MS);
  }

  useEffect(() => {
    const flush = () => {
      if (timer.current) clearTimeout(timer.current);
      pending.current?.();
    };
    window.addEventListener(EDITOR_FLUSH_EVENT, flush);
    return () => {
      mounted.current = false;
      window.removeEventListener(EDITOR_FLUSH_EVENT, flush);
      flush();
    };
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [] as number[];
    const haystack = draft.toLowerCase();
    const found: number[] = [];
    let cursor = haystack.indexOf(needle);
    while (cursor !== -1 && found.length < 500) {
      found.push(cursor);
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
    return found;
  }, [draft, query]);

  useEffect(() => {
    if (!matches.length) return;
    const index = matches[Math.min(active, matches.length - 1)];
    const element = textarea.current;
    if (!element) return;
    const before = draft.slice(0, index);
    const line = before.split("\n").length - 1;
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight || "22");
    element.scrollTop = Math.max(0, line * lineHeight - element.clientHeight / 2);
  }, [active, matches, draft]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && !composing.current) {
      event.preventDefault();
      const element = event.currentTarget;
      const { selectionStart, selectionEnd } = element;
      const result = indentRange(element.value, selectionStart, selectionEnd, event.shiftKey ? -1 : 1);
      setDraft(result.value);
      commit(result.value);
      const caret = event.shiftKey ? Math.max(result.value.lastIndexOf("\n", selectionStart - 1) + 1, selectionStart + result.delta) : selectionStart + result.delta;
      requestAnimationFrame(() => element.setSelectionRange(caret, caret));
      return;
    }
    if (event.key === "Escape") setQuery("");
  }

  async function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const images = extractClipboardImages(event.nativeEvent);
    const saveImages = onPasteImagesRef.current;
    const rollbackImages = onPasteImagesRollbackRef.current;
    const pasteOwnerId = taskOwnerIdRef.current;
    if (!images.length || !saveImages) return;

    event.preventDefault();
    const element = event.currentTarget;
    const originalValue = element.value;
    const originalStart = element.selectionStart;
    const originalEnd = element.selectionEnd;
    setPasteState("saving");
    try {
      const saved = await Promise.resolve(saveImages(images));
      if (!saved.length) {
        if (mounted.current) setPasteState("idle");
        return;
      }
      if (!mounted.current || !element.isConnected || taskOwnerIdRef.current !== pasteOwnerId) {
        await Promise.resolve(rollbackImages?.(saved)).catch(() => {});
        return;
      }
      const value = element.value;
      const start = value === originalValue ? originalStart : element.selectionStart;
      const end = value === originalValue ? originalEnd : element.selectionEnd;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const markdown = clipboardMarkdownForAttachments(saved);
      const beforeSeparator = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
      const afterSeparator = after && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
      const nextValue = `${before}${beforeSeparator}${markdown}${afterSeparator}${after}`;
      const caret = before.length + beforeSeparator.length + markdown.length;
      setDraft(nextValue);
      commit(nextValue);
      requestAnimationFrame(() => element.setSelectionRange(caret, caret));
      setPasteState("idle");
    } catch {
      if (mounted.current) setPasteState("error");
    }
  }

  return (
    <div className="markdown-source-editor">
      <div className="markdown-source-toolbar">
        <label className="markdown-search">
          <Search size={14} />
          <input value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} placeholder={copy.markdownSearch} aria-label={copy.markdownSearch} />
          <span role="status">{query ? (matches.length ? `${Math.min(active + 1, matches.length)}/${matches.length}` : copy.markdownSearchEmpty) : ""}</span>
          <button type="button" aria-label={copy.markdownSearchPrevious} title={copy.markdownSearchPrevious} disabled={!matches.length} onClick={() => setActive((value) => (value - 1 + matches.length) % Math.max(matches.length, 1))}><ChevronUp size={14} /></button>
          <button type="button" aria-label={copy.markdownSearchNext} title={copy.markdownSearchNext} disabled={!matches.length} onClick={() => setActive((value) => (value + 1) % Math.max(matches.length, 1))}><ChevronDown size={14} /></button>
        </label>
        <span className="markdown-hint">{copy.markdownTabHint}</span>
        {pasteState === "saving" && <span role="status" className="save-state saving">{copy.pasteImageSaving}</span>}
        {pasteState === "error" && <span role="alert" className="save-state error">{copy.pasteImageFailed}</span>}
      </div>
      <textarea
        ref={textarea}
        className="markdown-source-input"
        value={draft}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={getImportCopy(language).modeMarkdown}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          const value = event.currentTarget.value;
          setDraft(value);
          commit(value);
        }}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          if (!composing.current) commit(value);
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => { void onPaste(event); }}
        onBlur={() => { if (timer.current) clearTimeout(timer.current); pending.current?.(); }}
      />
    </div>
  );
}
