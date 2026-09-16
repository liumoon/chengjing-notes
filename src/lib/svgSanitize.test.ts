import { describe, expect, it } from "vitest";
import { imageDataUrlToBlob, sanitizeSvg, svgTextContent } from "./svgSanitize";

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

  it('保留指向檔案內部的漸層與遮罩參考，淺色圖不會變成一整塊黑', () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="paint0" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fdf6e3"/>
          <stop offset="1" stop-color="#e8f4ff"/>
        </linearGradient>
        <clipPath id="clip"><rect width="100" height="100" rx="8"/></clipPath>
      </defs>
      <rect width="100" height="100" fill="url(#paint0)" clip-path="url(#clip)"/>
    </svg>`;
    const result = sanitizeSvg(source);
    expect(result?.svg).toContain('fill="url(#paint0)"');
    expect(result?.svg).toContain('clip-path="url(#clip)"');
    expect(result?.warnings.filter((warning) => warning.startsWith('svg-attribute-removed:fill'))).toHaveLength(0);
  });

  it('外部 url 參考與悬空指針一律移除', () => {
    const external = sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="url(https://evil.example/a.png)"/></svg>');
    expect(external?.svg).not.toContain('url(https');
    const protocolRelative = sanitizeSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="url(//evil.example/a.png)"/></svg>');
    expect(protocolRelative?.svg).not.toContain('url(');
    expect(protocolRelative?.warnings).toContain('svg-external-reference:fill');
    const dangling = sanitizeSvg('<svg viewBox="0 0 10 10"><circle r="5" fill="url(#ghost)"/></svg>');
    expect(dangling?.svg).not.toContain('url(#ghost)');
    expect(dangling?.warnings).toContain('svg-dangling-reference:fill');
  });

  it('單引號與空白寫法的內部參考一樣留得住', () => {
    const result = sanitizeSvg('<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url( &#39;#g&#39; )"/></svg>');
    expect(result?.svg).toContain('url(');
    expect(result?.svg).toContain('#g');
  });
});

describe('SVG 文字抽取', () => {
  it('依文件順序取出 text 與 tspan', () => {
    const text = svgTextContent('<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="2">第一章<tspan> 創世記</tspan></text><path d="M0 0"/></svg>');
    expect(text).toBe('第一章 創世記');
  });

  it('全是路徑的 SVG 抽不到文字時回空字串，不throw', () => {
    expect(svgTextContent('<svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg>')).toBe('');
    expect(svgTextContent('not svg at all')).toBe('');
    expect(svgTextContent('')).toBe('');
  });
});

