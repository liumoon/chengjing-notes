/**
 * 編輯區縮放。
 *
 * 只影響顯示：Ctrl（macOS 亦可 ⌘）＋滾輪在 50%–200% 之間以 10% 為級距
 * 調整，文字與圖片一起縮放。數值記在本機、不進資料庫、不同步，
 * 因此不會把內容的字級或圖片尺寸寫死到卡片裡。
 */
export const EDITOR_ZOOM_MIN = 0.5;
export const EDITOR_ZOOM_MAX = 2;
export const EDITOR_ZOOM_STEP = 0.1;

export function clampEditorZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, Math.round(value * 100) / 100));
}

export function nextEditorZoom(value: number, direction: number) {
  const current = clampEditorZoom(value);
  if (!direction) return current;
  return clampEditorZoom(current + (direction > 0 ? EDITOR_ZOOM_STEP : -EDITOR_ZOOM_STEP));
}

export function editorZoomPercent(value: number) {
  return `${Math.round(clampEditorZoom(value) * 100)}%`;
}

/** Ctrl／⌘＋滾輪才算縮放；一般滾輪維持捲動頁面。 */
export function isZoomGesture(event: { ctrlKey?: boolean; metaKey?: boolean; deltaY?: number }) {
  return Boolean((event.ctrlKey || event.metaKey) && event.deltaY);
}

/**
 * 掛上非被動的滾輪監聽。React 的 onWheel 是被動監聽，
 * 在裡面呼叫 preventDefault 不會生效、頁面會跟著一起捲動；
 * 縮放要自己用 addEventListener(..., { passive: false })。
 */
export function attachZoomWheel(target: HTMLElement | null, onZoom: (direction: number) => void) {
  if (!target) return () => {};
  const handler = (event: WheelEvent) => {
    if (!isZoomGesture(event)) return;
    event.preventDefault();
    onZoom(event.deltaY < 0 ? 1 : -1);
  };
  target.addEventListener("wheel", handler, { passive: false });
  return () => target.removeEventListener("wheel", handler);
}
