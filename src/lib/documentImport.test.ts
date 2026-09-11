import "fake-indexeddb/auto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { db } from "../db";
import { getImportCopy } from "./importCopy";
import { referencedAttachmentIds } from "./attachmentRefs";

/**
 * 文件匯入的固定 fixture 驗證（規格：測試與驗收）。
 *
 * DOCX 以固定位元組重現：標題／清單／表格／連結／兩張內嵌圖片；
 * PDF 因單元測試環境沒有可用的 pdfjs-dist 執行檔，改以 mock 的
 * pdfRuntime 驗證管線行為（一般、掃描式、加密）。
 */

// 以檔名內容中的標記決定偽裝行為，避免真的載入 pdfjs。
vi.mock("./pdfRuntime", () => ({
  getPdfDocument: ({ data }: { data: Uint8Array }) => {
    const text = new TextDecoder().decode(data);
    if (text.includes("ENCRYPTED")) {
      return { promise: Promise.reject(new Error("PasswordException: encrypted document")), destroy: async () => undefined };
    }
    const scanned = text.includes("SCAN");
    return {
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (index: number) => ({
          getTextContent: async () => ({ items: scanned ? [] : [{ str: index === 1 ? "第一頁的搜尋文字" : "第二頁的搜尋文字" }] }),
        }),
      }),
      destroy: async () => undefined,
    };
  },
}));

const { importDocument } = await import("./importPipeline");

/** 固定 DOCX fixture（含標題/清單/表格/連結/兩張內嵌圖片），以 base64 內嵌保證可重現。 */
const DOCX_BASE64 =
  "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";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="#168"/></svg>');

function docxBlob(): Blob {
  const binary = atob(DOCX_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

beforeAll(() => { Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle }); return db.open(); });
beforeEach(async () => { for (const table of db.tables) await table.clear(); });

describe("HTML 匯入的圖片處理", () => {
  it("data URL 圖片轉成 inline 附件，正文不留長字串", async () => {
    const html = `<h1>圖片頁</h1><p><img src="data:image/png;base64,${PNG}" alt="小圖"></p>`;
    const outcome = await importDocument({ name: "pic.html", blob: new Blob([html], { type: "text/html" }), sourcePath: "/tmp/doc/pic.html" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    const content = outcome.card?.contentHtml || "";
    expect(content).toContain("attachment://");
    expect(content).not.toContain("data:image");
    const attachments = await db.attachments.toArray();
    const roles = attachments.map((attachment) => attachment.role);
    expect(roles).toContain("source");
    expect(roles.filter((role) => role === "inline").length).toBe(1);
    // 附件可被正文引用（也是 Undo 能恢復的前提：記錄不會被即時刪除）。
    expect(referencedAttachmentIds(content)).toEqual(attachments.filter((attachment) => attachment.role === "inline").map((attachment) => attachment.id));
  });

  it("缺圖保留文字占位，不留會發請求的 img 標籤", async () => {
    const html = `<p>看圖：</p><p><img src="./missing.png" alt="缺圖"></p>`;
    const outcome = await importDocument({ name: "missing.html", blob: new Blob([html], { type: "text/html" }), sourcePath: "/tmp/doc/missing.html" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings).toContain("asset-missing");
    const content = outcome.card?.contentHtml || "";
    expect(content).not.toContain("<img");
    expect(content).toContain("[缺圖](./missing.png)");
    // 沒有內嵌附件被建立，不留孤兒。
    const inline = (await db.attachments.toArray()).filter((attachment) => attachment.role === "inline");
    expect(inline.length).toBe(0);
  });

  it("網路圖片預設不連線：列來源、走占位、記錄在 remoteImages", async () => {
    const html = `<p><img src="https://track.example.org/pixel.gif" alt="追蹤"></p>`;
    const outcome = await importDocument({ name: "remote.html", blob: new Blob([html], { type: "text/html" }), sourcePath: "/tmp/doc/remote.html" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.remoteImages).toEqual(["https://track.example.org/pixel.gif"]);
    expect(outcome.warnings).toContain("remote-images-blocked");
    expect(outcome.card?.contentHtml).not.toContain("<img");
    // 預設路徑不得觸發任何下載嘗試（沒有 bridge，也不該有 image-rejected）。
    expect(outcome.warnings).not.toContain("image-rejected");
  });

  it("同意下載後失敗，仍不留下追蹤圖片標籤", async () => {
    const html = `<p><img src="https://track.example.org/pixel.gif" alt="追蹤"></p>`;
    const outcome = await importDocument({ name: "remote.html", blob: new Blob([html], { type: "text/html" }), sourcePath: "/tmp/doc/remote.html" }, { language: "zh-TW", allowRemoteImages: true });
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings).toContain("image-rejected");
    expect(outcome.card?.contentHtml).not.toContain("<img");
    expect(outcome.remoteImages).toEqual([]);
  });

  it("危險 HTML 不入正文", async () => {
    const html = `<script>alert(1)</script><p onmouseover="steal()">正常文字</p><iframe src="https://evil.example/x"></iframe><p><a href="javascript:alert(2)">壞連結</a></p>`;
    const outcome = await importDocument({ name: "evil.html", blob: new Blob([html], { type: "text/html" }), sourcePath: "/tmp/doc/evil.html" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    const content = outcome.card?.contentHtml || "";
    expect(content.toLowerCase()).not.toContain("script");
    expect(content).not.toContain("iframe");
    expect(content).not.toContain("onmouseover");
    expect(content).not.toContain("javascript:");
    expect(content).toContain("正常文字");
    expect(outcome.warnings).toContain("blocked-html");
  });
});

describe("SVG 與 Markdown 圖片處理", () => {
  it("standalone SVG 保留 source，並把清理後內容另存為 inline 附件", async () => {
    const outcome = await importDocument({
      name: "圖示.svg",
      blob: new Blob([decodeURIComponent(SVG)], { type: "image/svg+xml" }),
      sourcePath: "/tmp/doc/圖示.svg",
    }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.card?.kind).toBe("image");
    expect(outcome.card?.contentHtml).toContain("attachment://");
    expect(outcome.card?.contentHtml).not.toContain("<svg");
    const attachments = await db.attachments.toArray();
    expect(attachments.filter((attachment) => attachment.role === "source")).toHaveLength(1);
    expect(attachments.filter((attachment) => attachment.role === "inline")).toHaveLength(1);
  });

  it("危險 standalone SVG 會清理後建立 inline 附件，並保留 source", async () => {
    const outcome = await importDocument({
      name: "bad.svg",
      blob: new Blob(['<svg onload="alert(1)"><script>alert(2)</script></svg>'], { type: "image/svg+xml" }),
      sourcePath: "/tmp/doc/bad.svg",
    }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings).toContain("svg-sanitized");
    expect(outcome.card?.contentHtml).toContain("attachment://");
    expect((await db.attachments.toArray()).filter((attachment) => attachment.role === "source")).toHaveLength(1);
    expect((await db.attachments.toArray()).filter((attachment) => attachment.role === "inline")).toHaveLength(1);
  });

  it("Markdown 的 SVG data URL 會轉成 inline 附件，且正文不保留 data URL", async () => {
    const markdown = `# 圖示\n\n![向量圖](data:image/svg+xml,${SVG})`;
    const outcome = await importDocument({
      name: "vector.md",
      blob: new Blob([markdown], { type: "text/markdown" }),
      sourcePath: "/tmp/doc/vector.md",
    }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.card?.contentHtml).toContain("attachment://");
    expect(outcome.card?.contentHtml).not.toContain("data:image/svg+xml");
    expect((await db.attachments.toArray()).filter((attachment) => attachment.role === "inline")).toHaveLength(1);
  });

  it("Markdown 相對 SVG 找不到時保留可讀占位，不建立 inline 附件", async () => {
    const markdown = "![缺圖](./missing.svg)";
    const outcome = await importDocument({
      name: "missing.md",
      blob: new Blob([markdown], { type: "text/markdown" }),
      sourcePath: "/tmp/doc/missing.md",
    }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings).toContain("asset-missing");
    expect(outcome.card?.contentHtml).not.toContain("<img");
    expect(outcome.card?.contentHtml).toContain("./missing.svg");
    expect((await db.attachments.toArray()).filter((attachment) => attachment.role === "inline")).toHaveLength(0);
  });
});

describe("DOCX 固定 fixture", () => {
  it("保留標題、清單、表格、連結，並把兩張內嵌圖片附件化", async () => {
    const outcome = await importDocument({ name: "report.docx", blob: docxBlob(), sourcePath: "/tmp/doc/report.docx" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    const content = outcome.card?.contentHtml || "";
    expect(content).toContain("<h1>報告標題</h1>");
    expect(content).toContain("<h2>分析小節</h2>");
    expect(content).toContain("<ul>");
    expect(content).toContain("<table");
    expect(content).toContain('href="https://example.com/report"');
    // 兩張內嵌圖片 → 兩個 inline 附件 + 正文 attachment:// 引用。
    expect(referencedAttachmentIds(content).length).toBe(2);
    const attachments = await db.attachments.toArray();
    expect(attachments.filter((attachment) => attachment.role === "inline").length).toBe(2);
    expect(attachments.some((attachment) => attachment.role === "source" && attachment.name === "report.docx")).toBe(true);
    expect(outcome.card?.properties.format).toBe("Word");
  });
});

describe("TXT 與 PDF", () => {
  it("TXT 保留段落換行，不把內容誤解成 Markdown", async () => {
    const text = "# 不是標題\n\n第一行\n第二行\n\n- 這不是清單";
    const outcome = await importDocument({ name: "note.txt", blob: new Blob([text], { type: "text/plain" }), sourcePath: "/tmp/doc/note.txt" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    const content = outcome.card?.contentHtml || "";
    expect(content).toContain("<p># 不是標題</p>");
    expect(content).not.toContain("<h1");
    expect(content).not.toContain("<ul");
    expect(content).toContain("<br>");
  });

  it("可搜尋文字的 PDF：逐頁抽取並記錄頁數", async () => {
    const outcome = await importDocument({ name: "doc.pdf", blob: new Blob(["%PDF-1.4 normal"], { type: "application/pdf" }), sourcePath: "/tmp/doc/doc.pdf" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.card?.kind).toBe("pdf");
    expect(outcome.card?.properties.pages).toBe(2);
    expect(outcome.card?.plainText).toContain("第一頁的搜尋文字");
    expect(outcome.card?.plainText).toContain("第二頁的搜尋文字");
    expect(outcome.warnings).not.toContain("no-text");
  });

  it("掃描式 PDF 沒有文字時仍建立卡片並提示未擷取到文字", async () => {
    const outcome = await importDocument({ name: "scan.pdf", blob: new Blob(["%PDF-1.4 SCAN"], { type: "application/pdf" }), sourcePath: "/tmp/doc/scan.pdf" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(true);
    expect(outcome.card).toBeTruthy();
    expect(outcome.warnings).toContain("no-text");
    expect(getImportCopy("zh-TW").warningNoText).toContain("未擷取到文字");
    // 原檔仍保留為來源附件。
    const attachments = await db.attachments.toArray();
    expect(attachments.some((attachment) => attachment.role === "source" && attachment.name === "scan.pdf")).toBe(true);
  });

  it("加密 PDF 不建立半成品卡片，也不留下孤兒附件", async () => {
    const outcome = await importDocument({ name: "locked.pdf", blob: new Blob(["%PDF-1.4 ENCRYPTED"], { type: "application/pdf" }), sourcePath: "/tmp/doc/locked.pdf" }, { language: "zh-TW" });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(getImportCopy("zh-TW").errorEncrypted);
    expect(await db.cards.count()).toBe(0);
    expect(await db.attachments.count()).toBe(0);
  });
});
