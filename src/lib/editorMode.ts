export type CardEditorMode = "rich" | "markdown";

const STORAGE_KEY = "chengjing-card-editor-mode";

/**
 * 「富文字／Markdown」的模式偏好。
 * 只記在本機（localStorage），不進資料庫、不同步，因此不會讓不同裝置
 * 的編輯習慣互相覆蓋，也不会影響 JSON 備份協定。
 */
export function readEditorMode(): CardEditorMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "markdown" || stored === "rich" ? stored : "rich";
  } catch {
    return "rich";
  }
}

export function writeEditorMode(mode: CardEditorMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 無 localStorage 的環境就維持當次有效。 */
  }
}

export const EDITOR_FLUSH_EVENT = "chengjing:flush-editors";

export function requestEditorFlush() {
  window.dispatchEvent(new Event(EDITOR_FLUSH_EVENT));
}
