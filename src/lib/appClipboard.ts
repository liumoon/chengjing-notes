import { createCard, db } from "../db";
import type { CardRecord } from "../types";
import { sanitizeImportHtml } from "./htmlSanitize";

export type AppClipboardPayload =
  | { kind: "card-ref"; cardId: string }
  | { kind: "kanban-list-ref"; listId: string; boardId: string }
  | { kind: "board-nodes"; boardId: string; nodeIds: string[] }
  | { kind: "fragment-ref"; fragmentId: string };

export async function writeAppClipboard(payload: AppClipboardPayload, text: string, html?: string) {
  if (window.chengjing?.clipboard) return window.chengjing.clipboard.write({ payload, text, html });
  if (html && typeof ClipboardItem !== "undefined") {
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    })]);
    return { written: true };
  }
  await navigator.clipboard.writeText(text);
  return { written: true };
}

export async function readAppClipboard(): Promise<{ payload: AppClipboardPayload | null; text: string }> {
  if (window.chengjing?.clipboard) {
    const result = await window.chengjing.clipboard.read();
    return { text: result.text || "", payload: result.payload && typeof result.payload.kind === "string" ? result.payload as AppClipboardPayload : null };
  }
  return { text: await navigator.clipboard.readText(), payload: null };
}

export async function duplicateCardFromId(cardId: string, title?: string): Promise<CardRecord | null> {
  const card = await db.cards.get(cardId);
  if (!card) return null;
  const attachmentCopies = (await Promise.all(card.attachmentIds.map(async (id) => {
    const attachment = await db.attachments.get(id);
    return attachment ? { ...attachment, id: crypto.randomUUID(), createdAt: Date.now() } : null;
  }))).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (attachmentCopies.length) await db.attachments.bulkAdd(attachmentCopies);
  return createCard({
    ...card,
    id: undefined,
    title: title || card.title,
    state: card.state === "trash" ? "active" : card.state,
    favorite: false,
    deletedAt: undefined,
    attachmentIds: attachmentCopies.map((attachment) => attachment.id),
    tagIds: [...card.tagIds],
    properties: { ...card.properties },
  });
}

/**
 * 卡片複製時用的格式化 HTML。
 *
 * 以前右鍵「複製卡片」只給純文字，貼到 Word 或郵件後粗體、標題、清單
 * 全部消失。這裡沿用同一條清理管線，並把只有本機讀得到的附件圖片
 * 換成 `[alt]` 文字佔位，格式保留但不會留下破圖。
 */
export function formattedCardClipboardHtml(card: Pick<CardRecord, "title" | "contentHtml" | "plainText">) {
  const body = sanitizeImportHtml(card.contentHtml || "", { allowRemoteImages: false, allowDataImages: false });
  if (typeof DOMParser === "undefined") return `<h1>${escapeHtml(card.title)}</h1>${body}`;
  const document = new DOMParser().parseFromString(body, "text/html");
  document.body.querySelectorAll("img").forEach((image) => {
    const alt = (image.getAttribute("alt") || "").trim();
    image.replaceWith(document.createTextNode(alt ? `[${alt}]` : "[image]"));
  });
  const content = document.body.innerHTML.trim();
  return `<h1>${escapeHtml(card.title)}</h1>${content || escapeHtml(card.plainText || "")}`;
}

function escapeHtml(value: string) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] || character);
}
