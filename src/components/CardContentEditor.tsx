import { useEffect, useRef, useState } from "react";
import { Braces, Code, Sparkles } from "lucide-react";
import { RichEditor } from "./RichEditor";
import { MarkdownSourceEditor } from "./MarkdownSourceEditor";
import { fromMarkdown, plainTextFromHtml, toMarkdown } from "../lib/contentPipeline";
import { readEditorMode, requestEditorFlush, writeEditorMode, type CardEditorMode } from "../lib/editorMode";
import { getImportCopy } from "../lib/importCopy";
import type { AttachmentRecord } from "../types";
import { useI18n } from "../hooks/useI18n";

/**
 * 卡片內容編輯器的雙模式宿主。
 *
 * 富文字與 Markdown 是同一份 TipTap 文件的兩個投影：
 * 切到 Markdown 時用真正的 serializer 產出原始碼，切回富文字時用同一
 * 條管線解析，並把核取清單的 `data-task-id` 對回去，因此已同步的待辦
 * 不會被重建。存庫的永遠只有 `contentHtml`。
 */
interface CardContentEditorProps {
  contentHtml: string;
  onChange: (contentHtml: string, plainText: string) => unknown;
  onHighlight?: (text: string) => void | Promise<void>;
  taskOwnerId?: string;
  placeholder?: string;
  attachments?: AttachmentRecord[];
}

export function CardContentEditor({ contentHtml, onChange, onHighlight, taskOwnerId, placeholder, attachments = [] }: CardContentEditorProps) {
  const { language } = useI18n();
  const copy = getImportCopy(language);
  const [mode, setMode] = useState<CardEditorMode>(() => readEditorMode());
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(false);
  const htmlRef = useRef(contentHtml);
  const onChangeRef = useRef(onChange);
  const converting = useRef(false);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (converting.current) return;
    htmlRef.current = contentHtml;
  }, [contentHtml]);

  useEffect(() => {
    if (mode !== "markdown") return;
    let cancelled = false;
    setBusy(true);
    void toMarkdown(htmlRef.current || "<p></p>")
      .then((result) => { if (!cancelled) setMarkdown(result.markdown); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [mode]);

  async function switchTo(next: CardEditorMode) {
    if (next === mode) return;
    setBusy(true);
    try {
      if (next === "markdown") {
        // 富文字編輯器的存檔有 420ms debounce：切模式前先叫它把尚未交出的
        // 內容 flush 出來，否則切過去看到的 Markdown 會少了最後幾十毫秒打的字，
        // 使用者接著編輯 Markdown 時就會把那些字蓋掉。flush 的實際存檔排在
        // 微任務裡，所以讓出一個巨觀任務等它跑完，再讀最新內容。
        requestEditorFlush();
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        const result = await toMarkdown(htmlRef.current || "<p></p>");
        setMarkdown(result.markdown);
      } else {
        const chunk = await fromMarkdown(markdown, { previousHtml: htmlRef.current, allowRemoteImages: false });
        htmlRef.current = chunk.contentHtml;
        await onChangeRef.current(chunk.contentHtml, chunk.plainText || plainTextFromHtml(chunk.contentHtml));
      }
      setMode(next);
      writeEditorMode(next);
    } finally {
      converting.current = false;
      setBusy(false);
    }
  }

  async function handleMarkdownChange(value: string) {
    setMarkdown(value);
    converting.current = true;
    const chunk = await fromMarkdown(value, { previousHtml: htmlRef.current, allowRemoteImages: false });
    htmlRef.current = chunk.contentHtml;
    await onChangeRef.current(chunk.contentHtml, chunk.plainText || plainTextFromHtml(chunk.contentHtml));
    converting.current = false;
  }

  return (
    <div className="card-content-editor" data-mode={mode}>
      <div className="editor-mode-switch" role="tablist" aria-label={copy.modeRich}>
        <button type="button" role="tab" aria-selected={mode === "rich"} className={mode === "rich" ? "is-active" : ""} disabled={busy} onClick={() => void switchTo("rich")}><Braces size={14} />{copy.modeRich}</button>
        <button type="button" role="tab" aria-selected={mode === "markdown"} className={mode === "markdown" ? "is-active" : ""} disabled={busy} onClick={() => void switchTo("markdown")}><Code size={14} />{copy.modeMarkdown}</button>
        {busy && <span className="editor-mode-busy" role="status"><Sparkles size={12} className="spin" />{copy.switching}</span>}
      </div>
      <p className="editor-mode-hint">{copy.modeHint}</p>
      {mode === "rich"
        ? <RichEditor content={contentHtml} onChange={(html, text) => { htmlRef.current = html; return onChangeRef.current(html, text); }} placeholder={placeholder} onHighlight={onHighlight} taskOwnerId={taskOwnerId} attachments={attachments} compact />
        : <MarkdownSourceEditor markdown={markdown} onChange={(value) => void handleMarkdownChange(value)} placeholder={placeholder} />}
    </div>
  );
}
