import { describe, expect, it } from "vitest";
import { extractClipboardAttachments } from "./clipboardAttachments";

describe("剪貼簿附檔辨識", () => {
  it("擷取一般檔案並避免同一個檔案重複加入", () => {
    const file = new File(["pdf"], "報告.pdf", { type: "application/pdf", lastModified: 123 });
    const event = {
      clipboardData: {
        files: [file],
        items: [{ kind: "file", type: "application/pdf", getAsFile: () => file }],
      },
    } as unknown as ClipboardEvent;

    expect(extractClipboardAttachments(event)).toEqual([{ name: "報告.pdf", blob: file }]);
  });

  it("本機檔案的圖片若帶有 native path 會當作普通附件", () => {
    const file = new File(["png"], "photo.png", { type: "image/png" }) as File & { path: string };
    file.path = "/Users/test/photo.png";
    const event = { clipboardData: { files: [file], items: [] } } as unknown as ClipboardEvent;

    expect(extractClipboardAttachments(event)).toEqual([{ name: "photo.png", path: file.path, blob: file }]);
  });

  it("沒有 native path 的圖片交給內嵌圖片流程", () => {
    const file = new File(["png"], "screenshot.png", { type: "image/png" });
    const event = { clipboardData: { files: [file], items: [] } } as unknown as ClipboardEvent;

    expect(extractClipboardAttachments(event)).toEqual([]);
  });
});
