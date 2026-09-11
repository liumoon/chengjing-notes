import { describe, expect, it } from "vitest";
import { imageDataUrlToBlob, sanitizeSvg } from "./svgSanitize";

describe("SVG 清理", () => {
  it("保留安全的 SVG 結構與必要屬性", () => {
    const result = sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#000"/></svg>');
    expect(result).not.toBeNull();
    expect(result?.svg).toContain("<svg");
    expect(result?.svg).toContain("<rect");
    expect(result?.svg).toContain('viewBox="0 0 10 10"');
    expect(result?.svg).not.toContain("script");
  });

  it("移除 script、foreignObject、外部圖片與事件屬性", () => {
    const result = sanitizeSvg(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <foreignObject><div>bad</div></foreignObject>
        <image href="https://tracker.example/pixel.png"/>
        <rect width="10" height="10" onclick="alert(2)" style="fill:red"/>
      </svg>
    `);
    expect(result).not.toBeNull();
    expect(result?.warnings.length).toBeGreaterThan(0);
    expect(result?.svg.toLowerCase()).not.toContain("<script");
    expect(result?.svg.toLowerCase()).not.toContain("foreignobject");
    expect(result?.svg.toLowerCase()).not.toContain("<image");
    expect(result?.svg.toLowerCase()).not.toContain("onload");
    expect(result?.svg.toLowerCase()).not.toContain("onclick");
    expect(result?.svg.toLowerCase()).not.toContain("style=");
  });

  it("拒絕 DOCTYPE、非 SVG 根節點與過深內容", () => {
    expect(sanitizeSvg('<!DOCTYPE svg><svg></svg>')).toBeNull();
    expect(sanitizeSvg("<html><body>bad</body></html>")).toBeNull();

    let nested = '<rect width="1" height="1"/>';
    for (let index = 0; index < 40; index += 1) nested = `<g>${nested}</g>`;
    expect(sanitizeSvg(`<svg>${nested}</svg>`)).toBeNull();
  });

  it("解碼 base64 與 URL encoded SVG data URL", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>';
    const encoded = `data:image/svg+xml,${encodeURIComponent(source)}`;
    const base64 = `data:image/svg+xml;base64,${btoa(source)}`;
    const encodedBlob = imageDataUrlToBlob(encoded);
    const base64Blob = imageDataUrlToBlob(base64);
    expect(encodedBlob?.type).toBe("image/svg+xml");
    expect(base64Blob?.type).toBe("image/svg+xml");
    expect(await encodedBlob?.text()).toContain("<circle");
    expect(await base64Blob?.text()).toContain("<circle");
  });
});
