import { describe, expect, it } from "vitest";
import { checkSizeLimit, classifyDocument, IMPORT_LIMITS, sizeLimitFor } from "./importLimits";

/**
 * 匯入大小上限與檔案分類：文字 20 MB、DOCX 50 MB、PDF 100 MB；
 * 超限檔案在建立卡片之前就被擋下，不留半成品卡片。
 */
describe("檔案分類", () => {
  it("依副檔名與 MIME 分類", () => {
    expect(classifyDocument("note.md")).toBe("markdown");
    expect(classifyDocument("doc.MARKDOWN")).toBe("markdown");
    expect(classifyDocument("page.html")).toBe("html");
    expect(classifyDocument("report.pdf", "application/pdf")).toBe("pdf");
    expect(classifyDocument("letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(classifyDocument("photo.JPG")).toBe("image");
    expect(classifyDocument("voice.m4a", "audio/mp4")).toBe("audio");
    expect(classifyDocument("clip.mp4", "video/mp4")).toBe("video");
    expect(classifyDocument("notes.txt", "text/plain")).toBe("text");
    expect(classifyDocument("unknown.xyz", "application/octet-stream")).toBe("other");
  });
});

describe("大小上限", () => {
  it("各檔案類型有正確上限", () => {
    expect(sizeLimitFor("text")).toBe(20 * 1024 * 1024);
    expect(sizeLimitFor("docx")).toBe(50 * 1024 * 1024);
    expect(sizeLimitFor("pdf")).toBe(100 * 1024 * 1024);
    expect(IMPORT_LIMITS.remoteImageBytes).toBe(10 * 1024 * 1024);
    expect(IMPORT_LIMITS.remoteTotalBytesPerDocument).toBe(50 * 1024 * 1024);
    expect(IMPORT_LIMITS.remoteTimeoutMs).toBe(15_000);
    expect(IMPORT_LIMITS.maxRedirects).toBe(5);
  });

  it("超限不允許，範圍內允許", () => {
    expect(checkSizeLimit("text", 1024).allowed).toBe(true);
    expect(checkSizeLimit("text", IMPORT_LIMITS.textBytes + 1).allowed).toBe(false);
    expect(checkSizeLimit("pdf", IMPORT_LIMITS.pdfBytes).allowed).toBe(true);
    expect(checkSizeLimit("pdf", IMPORT_LIMITS.pdfBytes + 1).allowed).toBe(false);
  });
});
