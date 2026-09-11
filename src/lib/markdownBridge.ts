import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { getSchema } from "@tiptap/core";
import type { AnyExtension, JSONContent } from "@tiptap/core";
import { DOMParser as ProseMirrorDomParser, DOMSerializer, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Schema } from "@tiptap/pm/model";
import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * 澄境唯一的 Markdown ⇄ 文件轉換接觸面。
 *
 * `@tiptap/markdown` 目前是 Beta，因此版本在 package.json 釘死，且只有這個
 * 檔案允許 import 它。其他模組一律透過本介面的 `markdownToDocument`、
 * `documentToMarkdown`、`htmlToDocument`、`documentToHtml` 取得結果，
 * 未來換引擎或降級為純 DOM 序列化時，呼叫端不需要改動。
 */
export type MarkdownEngine = "tiptap" | "fallback";

export interface MarkdownBridgeResult<T> {
  value: T;
  engine: MarkdownEngine;
  warning?: string;
}

/** 核取清單的穩定識別，供 `taskSync` 綁定 `TaskRecord.sourceTaskId`。 */
export const SyncedTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      taskId: {
        default: null,
        parseHTML: (element: Element) => element.getAttribute("data-task-id"),
        renderHTML: (attributes: Record<string, unknown>) => (attributes.taskId ? { "data-task-id": attributes.taskId } : {}),
      },
    };
  },
});

/** 卡片編輯器、匯入器與匯出器共用的擴充集合，確保三方 schema 一致。 */
export function cardExtensions(): AnyExtension[] {
  return [
    StarterKit,
    Highlight.configure({ multicolor: true }),
    TaskList,
    SyncedTaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false, allowBase64: false }),
  ];
}

type Bridge = {
  schema: Schema;
  markdown: import("@tiptap/markdown").MarkdownManager;
  parser: ProseMirrorDomParser;
  serializer: DOMSerializer;
};

let bridge: Bridge | null = null;
let bridgeFailed = false;

async function loadBridge(): Promise<Bridge | null> {
  if (bridge) return bridge;
  if (bridgeFailed) return null;
  try {
    const { MarkdownManager } = await import("@tiptap/markdown");
    const extensions = cardExtensions();
    const schema = getSchema(extensions);
    bridge = {
      schema,
      markdown: new MarkdownManager({ extensions }),
      parser: ProseMirrorDomParser.fromSchema(schema),
      serializer: DOMSerializer.fromSchema(schema),
    };
    return bridge;
  } catch {
    bridgeFailed = true;
    return null;
  }
}

/** 測試與開發除錯用：強制下次重新建立 bridge。 */
export function resetMarkdownBridge() {
  bridge = null;
  bridgeFailed = false;
}

function serializeFragment(active: Bridge, doc: ProseMirrorNode) {
  const host = document.createElement("div");
  host.appendChild(active.serializer.serializeFragment(doc.content));
  return host.innerHTML || "<p></p>";
}

function parseHtmlFragment(active: Bridge, html: string) {
  const host = document.createElement("div");
  host.innerHTML = html || "<p></p>";
  return active.parser.parse(host, { preserveWhitespace: "full" });
}

export async function markdownToDocument(markdown: string): Promise<MarkdownBridgeResult<JSONContent>> {
  const text = stripBom(markdown);
  const active = await loadBridge();
  if (active) {
    try {
      return { value: active.markdown.parse(text), engine: "tiptap" };
    } catch {
      // fall through to the DOM based fallback below
    }
  }
  return { value: fallbackMarkdownToJson(text), engine: "fallback", warning: "markdown-engine-fallback" };
}

export async function documentToMarkdown(json: JSONContent): Promise<MarkdownBridgeResult<string>> {
  const active = await loadBridge();
  if (active) {
    try {
      return { value: active.markdown.serialize(json), engine: "tiptap" };
    } catch {
      // fall through
    }
  }
  return { value: "", engine: "fallback", warning: "markdown-engine-fallback" };
}

/** HTML → 正規化後的 TipTap 原生 HTML（保留 data-task-id 等語意屬性）。 */
export async function normalizeHtml(html: string): Promise<MarkdownBridgeResult<string>> {
  const active = await loadBridge();
  if (active) {
    try {
      return { value: serializeFragment(active, parseHtmlFragment(active, html)), engine: "tiptap" };
    } catch {
      // fall through
    }
  }
  return { value: html, engine: "fallback", warning: "html-normalize-fallback" };
}

export async function htmlToMarkdown(html: string): Promise<MarkdownBridgeResult<string>> {
  const active = await loadBridge();
  if (active) {
    try {
      return { value: active.markdown.serialize(parseHtmlFragment(active, html).toJSON()), engine: "tiptap" };
    } catch {
      // fall through
    }
  }
  return { value: "", engine: "fallback", warning: "markdown-engine-fallback" };
}

export async function documentToHtml(json: JSONContent): Promise<MarkdownBridgeResult<string>> {
  const active = await loadBridge();
  if (active) {
    try {
      return { value: serializeFragment(active, ProseMirrorNode.fromJSON(active.schema, json)), engine: "tiptap" };
    } catch {
      // fall through
    }
  }
  return { value: "", engine: "fallback", warning: "markdown-engine-fallback" };
}

export function stripBom(value: string) {
  return String(value || "").replace(/^\uFEFF/, "");
}

/* -------------------------------------------------------------------------- */
/* 降級路徑：TipTap 無法載入時（例如無 DOM 環境）仍要能產出可用內容。        */
/* -------------------------------------------------------------------------- */

function fallbackMarkdownToJson(markdown: string): JSONContent {
  const html = DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }) as string, {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "code", "pre", "hr", "a", "table", "thead", "tbody", "tr", "th", "td", "img", "input"],
    ALLOWED_ATTR: ["href", "title", "src", "alt", "type", "checked", "disabled", "colspan", "rowspan"],
  });
  return { type: "doc", content: nodesFromElement(html) };
}

function inlineContent(element: Element): JSONContent[] {
  const nodes: JSONContent[] = [];
  const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [];
  const walk = (node: Node, inherited: Array<{ type: string; attrs?: Record<string, unknown> }>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      if (text) nodes.push({ type: "text", text, ...(inherited.length ? { marks: inherited.map((mark) => ({ ...mark })) } : {}) });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    const next = [...inherited];
    if (tag === "strong" || tag === "b") next.push({ type: "bold" });
    else if (tag === "em" || tag === "i") next.push({ type: "italic" });
    else if (tag === "del" || tag === "s" || tag === "strike") next.push({ type: "strike" });
    else if (tag === "code") next.push({ type: "code" });
    else if (tag === "a") next.push({ type: "link", attrs: { href: node.getAttribute("href") || "", title: node.getAttribute("title") } });
    else if (tag === "br") { nodes.push({ type: "hardBreak" }); return; }
    else if (tag === "img") { nodes.push({ type: "image", attrs: { src: node.getAttribute("src") || "", alt: node.getAttribute("alt"), title: node.getAttribute("title") } }); return; }
    node.childNodes.forEach((child) => walk(child, next));
  };
  element.childNodes.forEach((child) => walk(child, marks));
  return nodes;
}

function blockContent(element: Element): JSONContent[] {
  const children = [...element.children];
  if (!children.length) return inlineContent(element);
  return children.map((child) => nodeFromElement(child));
}

function nodeFromElement(element: Element): JSONContent {
  const tag = element.tagName.toLowerCase();
  if (tag === "p") return { type: "paragraph", content: inlineContent(element) };
  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return { type: "heading", attrs: { level: Number(tag.slice(1)) }, content: inlineContent(element) };
  if (tag === "blockquote") return { type: "blockquote", content: blockContent(element) };
  if (tag === "pre") return { type: "codeBlock", attrs: { language: element.querySelector("code")?.className?.match(/language-([\w-]+)/)?.[1] || null }, content: [{ type: "text", text: element.textContent || "" }] };
  if (tag === "hr") return { type: "horizontalRule" };
  if (tag === "ul" || tag === "ol") return { type: tag === "ul" ? "bulletList" : "orderedList", content: [...element.children].map((item) => ({ type: "listItem", content: blockContent(item) })) };
  if (tag === "table") return { type: "table", content: [...element.querySelectorAll("tr")].map((row) => ({ type: "tableRow", content: [...row.children].map((cell) => ({ type: cell.tagName.toLowerCase() === "th" ? "tableHeader" : "tableCell", content: blockContent(cell) })) })) };
  return { type: "paragraph", content: inlineContent(element) };
}

function nodesFromElement(html: string): JSONContent[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  return [...host.children].map((child) => {
    const tag = child.tagName.toLowerCase();
    if (tag === "ul" && child.querySelector(":scope > li > input[type=checkbox]")) {
      return { type: "taskList", content: [...child.children].map((item) => ({ type: "taskItem", attrs: { checked: Boolean((item.querySelector("input[type=checkbox]") as HTMLInputElement | null)?.checked) }, content: blockContent(item) })) };
    }
    return nodeFromElement(child);
  });
}
