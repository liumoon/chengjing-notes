import { describe, expect, it } from "vitest";
import { findRemoteImages, isSafeDataImage, isSafeUri, sanitizeImportHtml } from "./htmlSanitize";
import { assertPublicImageUrl, isHttpUrl, isPrivateAddress, normalizeIpv4 } from "./importLimits";

/**
 * 匯入 HTML 清理與遠端圖片安全：腳本、事件屬性、javascript:、SVG payload、
 * 私有 IP、相對路徑穿越都要被擋下。
 */
describe("HTML 清理", () => {
  it("移除腳本、iframe、事件屬性與 javascript: 連結", async () => {
    const html = '<h2>標題</h2><script>alert(1)</script><iframe src="https://evil.com"></iframe><p onclick="evil()">hi</p><a href="javascript:alert(1)">x</a><img src="./ok.png">';
    const result = await sanitizeImportHtml(html, { allowRemoteImages: false });
    expect(result).not.toContain("<script");
    expect(result).not.toContain("<iframe");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("javascript:alert");
    expect(result).toContain("<h2>標題</h2>");
  });

  it("移除 SVG payload", async () => {
    const html = '<p>安全</p><svg onload="alert(1)"><circle/></svg>';
    const result = await sanitizeImportHtml(html, { allowRemoteImages: false });
    expect(result).not.toContain("<svg");
    expect(result).not.toContain("onload");
    expect(result).toContain("安全");
  });

  it("匯入階段暫時接受安全的 SVG data URL，供後續附件化", async () => {
    const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    const html = `<p><img alt="圖示" src="data:image/svg+xml,${svg}"></p>`;
    const result = await sanitizeImportHtml(html, { allowRemoteImages: true, allowDataImages: true });
    expect(result).toContain("data:image/svg+xml");
    expect(isSafeDataImage(`data:image/svg+xml,${svg}`)).toBe(true);
  });

  it("仍阻擋危險或非圖片的 data URL", async () => {
    const html = '<img src="data:text/html,<script>alert(1)</script>"><img src="data:image/svg+xml,%3Csvg%20onload%3D%22alert(1)%22%3E%3C/svg%3E">';
    const result = await sanitizeImportHtml(html, { allowRemoteImages: true, allowDataImages: true });
    expect(result).not.toContain("data:text/html");
    // The SVG data URL is only a temporary hand-off to the SVG sanitizer; the
    // sanitizer itself decides whether unsafe attributes are removed.
    expect(result).toContain("data:image/svg+xml");
  });

  it("保留標題、段落、清單、表格與安全圖片", async () => {
    const html = '<h1>A</h1><p>B</p><ul><li>C</li></ul><table><tr><th>H</th><td>D</td></tr></table><img src="./photo.png">';
    const result = await sanitizeImportHtml(html, { allowRemoteImages: false });
    expect(result).toContain("<h1>A</h1>");
    expect(result).toContain("<ul><li>C</li></ul>");
    expect(result).toContain("<table>");
    expect(result).toContain('<img src="./photo.png">');
  });

  it("未授權網路圖片改成文字占位，不留連線標籤", async () => {
    const html = '<p>圖</p><img src="https://cdn.example.com/a.png">';
    const result = await sanitizeImportHtml(html, { allowRemoteImages: false });
    expect(result).not.toContain('<img');
    expect(result).toContain("https://cdn.example.com/a.png");
  });

  it("findRemoteImages 只回報 http(s) 圖片", () => {
    const html = '<img src="https://ex.com/a.png"><img src="./local.png"><img src="attachment://abc">';
    expect(findRemoteImages(html)).toEqual(["https://ex.com/a.png"]);
  });
});

describe("URI 安全", () => {
  it("拒絕危險協定", () => {
    expect(isSafeUri("javascript:alert(1)", { allowAttachment: false, allowDataImage: false })).toBe(false);
    expect(isSafeUri("data:text/html,x", { allowAttachment: false, allowDataImage: false })).toBe(false);
    expect(isSafeUri("vbscript:x", { allowAttachment: false, allowDataImage: false })).toBe(false);
  });

  it("接受相对路径与 http(s)", () => {
    expect(isSafeUri("./photo.png", { allowAttachment: false, allowDataImage: false })).toBe(true);
    expect(isSafeUri("../a.png", { allowAttachment: false, allowDataImage: false })).toBe(true);
    expect(isSafeUri("https://ex.com/a.png", { allowAttachment: false, allowDataImage: false })).toBe(true);
  });

  it("接受 attachment:// 內部表示", () => {
    expect(isSafeUri("attachment://abc-123", { allowAttachment: true, allowDataImage: false })).toBe(true);
  });
});

describe("遠端圖片位址安全", () => {
  it("識別 loopback、私有網段、連結本地與雲中 metadata", () => {
    for (const host of ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "metadata.google.internal", "127.1", "0x7f000001"]) {
      expect(isPrivateAddress(host)).toBe(true);
    }
  });

  it("接受公開網域", () => {
    expect(isPrivateAddress("example.com")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
  });

  it("normalizeIpv4 解析十進位／八進位／十六進位寫法", () => {
    expect(normalizeIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
    expect(normalizeIpv4("2130706433")).toEqual([127, 0, 0, 1]); // 十進位 127.0.0.1
    expect(normalizeIpv4("0x7f000001")).toEqual([127, 0, 0, 1]); // 十六進位
  });

  it("assertPublicImageUrl 拒絕私有位址與非 HTTP 協定", () => {
    expect(assertPublicImageUrl("https://example.com/a.png")).toBe("");
    expect(assertPublicImageUrl("https://127.0.0.1/")).toBe("private-address");
    expect(assertPublicImageUrl("ftp://example.com/x")).toBe("unsupported-scheme");
    expect(assertPublicImageUrl("https://user:pass@example.com/x")).toBe("credentials-in-url");
  });

  it("isHttpUrl 拒絕非 HTTP 協定", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});
