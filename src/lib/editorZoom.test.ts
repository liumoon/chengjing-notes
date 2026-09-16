import { describe, expect, it } from "vitest";
import {
  EDITOR_ZOOM_MAX,
  EDITOR_ZOOM_MIN,
  clampEditorZoom,
  editorZoomPercent,
  isZoomGesture,
  nextEditorZoom,
} from "./editorZoom";

describe("編輯區縮放", () => {
  it("鎖在 50%–200% 之間，並把浮點誤差收斂到整百分比", () => {
    expect(clampEditorZoom(0)).toBe(EDITOR_ZOOM_MIN);
    expect(clampEditorZoom(99)).toBe(EDITOR_ZOOM_MAX);
    expect(clampEditorZoom(Number.NaN)).toBe(1);
    expect(clampEditorZoom(1.234)).toBe(1.23);
    expect(editorZoomPercent(1)).toBe("100%");
  });

  it("以 10% 為級距遞增遞減，到邊界就不再動", () => {
    let zoom = 1;
    for (let i = 0; i < 20; i += 1) zoom = nextEditorZoom(zoom, 1);
    expect(zoom).toBe(EDITOR_ZOOM_MAX);
    for (let i = 0; i < 40; i += 1) zoom = nextEditorZoom(zoom, -1);
    expect(zoom).toBe(EDITOR_ZOOM_MIN);
    expect(nextEditorZoom(1.1, 1)).toBe(1.2);
    expect(nextEditorZoom(1, 0)).toBe(1);
  });

  it("只有按著 Ctrl 或 ⌘ 的滾輪才算縮放手勢", () => {
    expect(isZoomGesture({ ctrlKey: true, deltaY: -10 })).toBe(true);
    expect(isZoomGesture({ metaKey: true, deltaY: 10 })).toBe(true);
    expect(isZoomGesture({ deltaY: -10 })).toBe(false);
    expect(isZoomGesture({ ctrlKey: true, deltaY: 0 })).toBe(false);
  });
});
