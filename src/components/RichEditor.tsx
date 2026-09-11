import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import {
  Bold,
  Braces,
  CheckSquare,
  Heading2,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
} from "lucide-react";
import { useI18n } from "../hooks/useI18n";
import { editorTaskRecordId, normalizeEditorTaskHtml, syncCardTasksFromHtml } from "../lib/taskSync";
import { showContextMenu } from "../lib/contextMenu";
import { cardExtensions } from "../lib/markdownBridge";
import { attachmentRef, canonicalizeImageSrcs, releaseResolvedUrls, resolveInlineImageSrcs } from "../lib/attachmentRefs";
import { extractClipboardImages } from "../lib/clipboardImages";
import { getImportCopy } from "../lib/importCopy";
import type { AttachmentRecord } from "../types";
import type { ClipboardImageInput } from "../lib/clipboardImages";

/**
 * 富文字模式。
 *
 * 擴充集合直接取自 `markdownBridge.cardExtensions()`，確保編輯器、
 * 匯入器與匯出器共用同一個 schema。正文裡的圖片以 `attachment://<id>`
 * 存庫，畫面顯示前才解析成桌面／Android 本機 URL。
 */
interface RichEditorProps {
  content: string;
  onChange: (html: string, text: string) => unknown;
  placeholder?: string;
  autoFocus?: boolean;
  compact?: boolean;
  onHighlight?: (text: string) => void | Promise<void>;
  taskOwnerId?: string;
  attachments?: AttachmentRecord[];
  onPasteImages?: (inputs: ClipboardImageInput[]) => Promise<AttachmentRecord[]> | AttachmentRecord[];
  onPasteImagesRollback?: (attachments: AttachmentRecord[]) => Promise<void> | void;
}

export function RichEditor({ content, onChange, placeholder, autoFocus = false, compact = false, onHighlight, taskOwnerId, attachments = [], onPasteImages, onPasteImagesRollback }: RichEditorProps) {
  const { t, language } = useI18n();
  const copy = getImportCopy(language);
  const resolvedPlaceholder = placeholder || t("editor.start");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange);
  const onPasteImagesRef = useRef(onPasteImages);
  const onPasteImagesRollbackRef = useRef(onPasteImagesRollback);
  const taskOwnerIdRef = useRef(taskOwnerId);
  const attachmentsRef = useRef(attachments);
  const editorRef = useRef<Editor | null>(null);
  const saveRevision = useRef(0);
  const objectUrls = useRef<string[]>([]);
  const mounted = useRef(true);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [pasteState, setPasteState] = useState<"idle" | "saving" | "error">("idle");
  taskOwnerIdRef.current = taskOwnerId;
  const [initialContent] = useState(() => {
    const resolved = resolveInlineImageSrcs(content || "<p></p>", attachments);
    objectUrls.current.push(...resolved.resolved);
    return resolved.html;
  });

  const editor = useEditor({
    extensions: cardExtensions(),
    content: initialContent,
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        class: "prose-editor",
        "data-placeholder": resolvedPlaceholder,
        spellcheck: "true",
      },
      handlePaste: (_view, event) => {
        const images = extractClipboardImages(event);
        const saveImages = onPasteImagesRef.current;
        if (!images.length || !saveImages) return false;

        event.preventDefault();
        const activeEditor = editorRef.current;
        if (!activeEditor || activeEditor.isDestroyed) return true;
        const pasteOwnerId = taskOwnerIdRef.current;
        const rollbackImages = onPasteImagesRollbackRef.current;
        const originalDoc = activeEditor.state.doc;
        const originalSelection = activeEditor.state.selection;
        setPasteState("saving");
        void Promise.resolve(saveImages(images)).then((saved) => {
          if (!saved.length) {
            if (mounted.current) setPasteState("idle");
            return;
          }
          const currentEditor = editorRef.current;
          if (!mounted.current || !currentEditor || currentEditor.isDestroyed || taskOwnerIdRef.current !== pasteOwnerId) {
            return Promise.resolve(rollbackImages?.(saved))
              .catch(() => {})
              .then(() => {
                if (mounted.current) setPasteState(taskOwnerIdRef.current === pasteOwnerId ? "error" : "idle");
              });
          }
          const previousAttachments = attachmentsRef.current;
          const mergedAttachments = [
            ...previousAttachments,
            ...saved.filter((attachment) => !previousAttachments.some((current) => current.id === attachment.id)),
          ];
          attachmentsRef.current = mergedAttachments;
          try {
            // Restore the selection only when the document stayed untouched while
            // the asynchronous native attachment write was in progress.
            if (currentEditor.state.doc.eq(originalDoc)) {
              currentEditor.commands.setTextSelection({
                from: originalSelection.from,
                to: originalSelection.to,
              });
            }
            const inserted = currentEditor.chain().focus().insertContent(saved.map((attachment) => ({
              type: "image",
              attrs: { src: attachmentRef(attachment.id), alt: attachment.name },
            }))).run();
            if (!inserted) throw new Error("clipboard-image-insert-failed");

            // The document stores attachment:// references, while the editor needs
            // a local URL to render the image immediately after the async save.
            const selection = currentEditor.state.selection;
            const resolved = resolveInlineImageSrcs(currentEditor.getHTML(), mergedAttachments);
            if (resolved.resolved.length) {
              releaseResolvedUrls(objectUrls.current);
              objectUrls.current = resolved.resolved;
              currentEditor.commands.setContent(resolved.html, { emitUpdate: false });
              const maxPosition = currentEditor.state.doc.content.size;
              try {
                currentEditor.commands.setTextSelection({
                  from: Math.min(selection.from, maxPosition),
                  to: Math.min(selection.to, maxPosition),
                });
              } catch {
                // Image attributes do not normally change document positions.
              }
            }
            if (mounted.current) setPasteState("idle");
          } catch (error) {
            attachmentsRef.current = previousAttachments;
            return Promise.resolve(rollbackImages?.(saved))
              .catch(() => {})
              .then(() => {
                if (mounted.current) setPasteState("error");
                throw error;
              });
          }
        }).catch(() => { if (mounted.current) setPasteState("error"); });
        return true;
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      setSaveState("saving");
      if (timer.current) clearTimeout(timer.current);
      const displayHtml = activeEditor.getHTML();
      const storedHtml = canonicalizeImageSrcs(displayHtml, attachmentsRef.current);
      const normalized = normalizeEditorTaskHtml(storedHtml);
      const plainText = activeEditor.getText({ blockSeparator: "\n" });
      const save = onChangeRef.current;
      const owner = taskOwnerIdRef.current;
      const revision = ++saveRevision.current;
      pendingSave.current = () => {
        pendingSave.current = null;
        if (!activeEditor.isDestroyed && activeEditor.getHTML() === displayHtml && normalized.html !== displayHtml) {
          const selection = activeEditor.state.selection;
          activeEditor.commands.setContent(resolveInlineImageSrcs(normalized.html, attachmentsRef.current).html, { emitUpdate: false });
          activeEditor.commands.setTextSelection({ from: selection.from, to: selection.to });
        }
        void Promise.resolve().then(() => save(normalized.html, plainText)).then(async () => {
          if (owner) await syncCardTasksFromHtml(owner, normalized.html);
          if (revision === saveRevision.current) setSaveState("saved");
        }).catch(() => { if (revision === saveRevision.current) setSaveState("error"); });
      };
      timer.current = setTimeout(() => pendingSave.current?.(), 420);
    },
  }, [resolvedPlaceholder]);

  useEffect(() => {
    editorRef.current = editor;
    return () => { editorRef.current = null; };
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.getHTML() === content) return;
    const resolved = resolveInlineImageSrcs(content || "<p></p>", attachments);
    releaseResolvedUrls(objectUrls.current);
    objectUrls.current = resolved.resolved;
    editor.commands.setContent(resolved.html, { emitUpdate: false });
  }, [content, editor, attachments]);

  useEffect(() => {
    onChangeRef.current = onChange;
    onPasteImagesRef.current = onPasteImages;
    onPasteImagesRollbackRef.current = onPasteImagesRollback;
    taskOwnerIdRef.current = taskOwnerId;
    attachmentsRef.current = attachments;
  }, [onChange, onPasteImages, onPasteImagesRollback, taskOwnerId, attachments]);

  useEffect(() => {
    if (!editor || !taskOwnerId) return;
    const storedHtml = canonicalizeImageSrcs(editor.getHTML(), attachments);
    const normalized = normalizeEditorTaskHtml(storedHtml);
    if (normalized.html !== storedHtml) {
      editor.commands.setContent(resolveInlineImageSrcs(normalized.html, attachments).html, { emitUpdate: false });
      onChangeRef.current(normalized.html, editor.getText({ blockSeparator: "\n" }));
    }
    void syncCardTasksFromHtml(taskOwnerId, normalized.html);
  }, [editor, taskOwnerId, attachments]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      // The captured HTML and owner remain valid after the editor view is destroyed.
      pendingSave.current?.();
      releaseResolvedUrls(objectUrls.current);
      objectUrls.current = [];
    };
  }, [taskOwnerId]);

  useEffect(() => {
    const flush = () => { if (timer.current) clearTimeout(timer.current); pendingSave.current?.(); };
    window.addEventListener("chengjing:flush-editors", flush);
    return () => window.removeEventListener("chengjing:flush-editors", flush);
  }, []);

  if (!editor) return null;

  function toggleHighlight() {
    const { from, to } = editor.state.selection;
    const selectedText = from === to ? "" : editor.state.doc.textBetween(from, to, " ").trim();
    const removingHighlight = editor.isActive("highlight");
    editor.chain().focus().toggleHighlight().run();
    if (!removingHighlight && selectedText && onHighlight) void onHighlight(selectedText);
  }

  const tool = (label: string, active: boolean, action: () => void, icon: React.ReactNode) => (
    <button type="button" aria-label={label} data-tooltip={label} className={active ? "is-active" : ""} onClick={action}>{icon}</button>
  );

  return (
    <div className={`rich-editor ${compact ? "is-compact" : ""}`} onContextMenu={(event) => {
      if (!taskOwnerId) return;
      const item = (event.target as HTMLElement).closest<HTMLElement>('ul[data-type="taskList"] li[data-task-id]');
      const sourceTaskId = item?.dataset.taskId;
      if (!sourceTaskId) return;
      event.preventDefault();
      event.stopPropagation();
      showContextMenu({ kind: "task", id: editorTaskRecordId(taskOwnerId, sourceTaskId) }, event.clientX, event.clientY);
    }}>
      <div className="editor-toolbar" aria-label={t("editor.toolbar")}>
        <div>
          {tool(t("editor.bold"), editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), <Bold size={15} />)}
          {tool(t("editor.italic"), editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), <Italic size={15} />)}
          {tool(t("editor.strike"), editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), <Strikethrough size={15} />)}
          {tool(onHighlight ? t("editor.highlightAndSave") : t("editor.highlight"), editor.isActive("highlight"), toggleHighlight, <Highlighter size={15} />)}
          <i />
          {tool(t("editor.heading2"), editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), <Heading2 size={15} />)}
          {tool(t("editor.bullets"), editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), <List size={15} />)}
          {tool(t("editor.numbered"), editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), <ListOrdered size={15} />)}
          {tool(t("editor.tasks"), editor.isActive("taskList"), () => editor.chain().focus().toggleTaskList().run(), <CheckSquare size={15} />)}
          {tool(t("editor.quote"), editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), <Quote size={15} />)}
          {tool(t("editor.code"), editor.isActive("codeBlock"), () => editor.chain().focus().toggleCodeBlock().run(), <Braces size={15} />)}
          {tool(getTableLabel(language), editor.isActive("table"), () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), <Table size={15} />)}
        </div>
        <div>
          {pasteState === "saving" && <span role="status" className="save-state saving">{copy.pasteImageSaving}</span>}
          {pasteState === "error" && <span role="alert" className="save-state error">{copy.pasteImageFailed}</span>}
          <span role={saveState === "error" ? "alert" : "status"} className={`save-state ${saveState}`}>{saveState === "error" ? ({"zh-TW":"儲存失敗，請勿關閉","zh-CN":"保存失败，请勿关闭",en:"Save failed. Keep this open.",ja:"保存できません。閉じないでください。",ko:"저장 실패. 닫지 마세요."})[language] : saveState === "saving" ? t("common.saving") : t("common.saved")}</span>
          {tool(t("editor.undo"), false, () => editor.chain().focus().undo().run(), <Undo2 size={15} />)}
          {tool(t("editor.redo"), false, () => editor.chain().focus().redo().run(), <Redo2 size={15} />)}
        </div>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function getTableLabel(language: string) {
  return ({ "zh-TW": "插入表格", "zh-CN": "插入表格", en: "Insert table", ja: "表を挿入", ko: "표 삽입" } as Record<string, string>)[language] || "Insert table";
}
