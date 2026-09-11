import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR_FLUSH_EVENT, readEditorMode, requestEditorFlush, writeEditorMode } from "./editorMode";

/**
 * 雙模式偏好與 flush 機制的守門測試。
 *
 * `editorMode.ts` 只管兩件事：本機記住「富文字／Markdown」偏好，以及
 * 用一個全域事件請所有編輯器立刻交出 debounce 中的內容。富文字編輯器、
 * Markdown 原始碼框與卡片面板都用同一個事件名收尾（其中兩處是字串常數），
 * 名字一旦漂移，切模式與關面板就會少存最後 420ms 的內容。
 */
describe("卡片編輯器模式偏好", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("預設是富文字，寫入後讀得回來", () => {
    expect(readEditorMode()).toBe("rich");
    writeEditorMode("markdown");
    expect(readEditorMode()).toBe("markdown");
    writeEditorMode("rich");
    expect(readEditorMode()).toBe("rich");
  });

  it("髒值或沒 localStorage 時退回富文字", () => {
    localStorage.setItem("chengjing-card-editor-mode", "nano-banana");
    expect(readEditorMode()).toBe("rich");

    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("no storage");
    };
    expect(readEditorMode()).toBe("rich");
    expect(() => writeEditorMode("markdown")).not.toThrow();
    Storage.prototype.getItem = original;
  });

  it("模式偏好只留本機，不寫進任何資料庫欄位", () => {
    writeEditorMode("markdown");
    expect(Object.keys(localStorage)).toEqual(["chengjing-card-editor-mode"]);
  });
});

describe("編輯器 flush 事件", () => {
  it("事件名與 RichEditor、CardEditorPanel 監聽的字串一致", () => {
    expect(EDITOR_FLUSH_EVENT).toBe("chengjing:flush-editors");
  });

  it("requestEditorFlush 會同步通知所有訂閱者", () => {
    const seen: string[] = [];
    const listener = () => seen.push("flushed");
    window.addEventListener(EDITOR_FLUSH_EVENT, listener);
    requestEditorFlush();
    window.removeEventListener(EDITOR_FLUSH_EVENT, listener);
    expect(seen).toEqual(["flushed"]);
  });

  it("flush 排進微任務的存檔，讓出一個巨觀任務後一定已完成", async () => {
    // 重現 RichEditor 的收尾形態：事件處理把實際存檔排在微任務裡。
    const store = { html: "<p>舊內容</p>" };
    const listener = () => {
      Promise.resolve().then(() => {
        store.html = "<p>新內容</p>";
      });
    };
    window.addEventListener(EDITOR_FLUSH_EVENT, listener);

    requestEditorFlush();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    window.removeEventListener(EDITOR_FLUSH_EVENT, listener);

    expect(store.html).toBe("<p>新內容</p>");
  });
});
