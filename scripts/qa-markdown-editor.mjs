import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const base = process.env.CHENGJING_URL || "http://127.0.0.1:5173";
const output = path.resolve("qa-artifacts/markdown-editor");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1540, height: 960 }, colorScheme: "dark", locale: "zh-TW" });
const page = await context.newPage();
await page.addInitScript(() => {
  document.addEventListener("error", (event) => {
    const node = event.target;
    if (!node || node.tagName !== "IMG") return;
    const chain = [];
    let cursor = node;
    while (cursor && chain.length < 6) { chain.push(cursor.className || cursor.tagName); cursor = cursor.parentElement; }
    console.warn("IMGFAIL " + String(node.getAttribute("src")).slice(0, 48) + " :: " + chain.join(" < "));
  }, true);
});
page.on("requestfailed", (request) => console.warn("REQFAIL " + String(request.failure()?.errorText) + " " + request.url().slice(0, 120)));

page.setDefaultTimeout(15_000);
const errors = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); if (message.type() === "warning") console.log("WARN:", message.text().slice(0, 220)); });

async function cards() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("chengjing");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const query = request.result.transaction("cards", "readonly").objectStore("cards").getAll();
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    };
  }));
}

await page.goto(base, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "卡片庫", exact: true }).click();
await page.locator(".library-card").first().click();
await page.locator(".card-editor-panel").waitFor();
await page.waitForTimeout(600);

const proseBox = await page.locator(".prose-editor").boundingBox();
const fillsHeight = Boolean(proseBox && proseBox.height > 240);

await page.locator(".editor-mode-switch button").filter({ hasText: "Markdown" }).click();
await page.locator(".markdown-codemirror .cm-editor").waitFor();
const cmBox = await page.locator(".markdown-codemirror").boundingBox();
const editorMounted = Boolean(cmBox && cmBox.height > 240);

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#4a90d9"/><text x="16" y="54" font-size="26" fill="#fdf6e3">澄境</text></svg>';
const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
const source = ["## 章節標題", "", "- 第一項", "- 第二項", "", "![示意圖](" + dataUrl + ")", "", "結尾文字"].join("\n");
await page.locator(".markdown-codemirror .cm-content").click();
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type(source);
await page.waitForTimeout(1000);
const previewHtml = await page.locator(".markdown-codemirror .cm-content").innerHTML();
const previewBlocks = await page.locator(".md-preview-block").count();
const previewRenders = previewBlocks >= 3 && previewHtml.includes("<h2") && previewHtml.includes("<li");
const inlineImages = await page.locator(".md-preview-block img").count();
await page.screenshot({ path: path.join(output, "01-markdown-live-preview.png") });

await page.locator(".md-preview-block img").first().dblclick();
await page.locator(".media-viewer").waitFor();
const viewerOpen = true;
await page.screenshot({ path: path.join(output, "02-media-viewer.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const viewerClosed = (await page.locator(".media-viewer").count()) === 0;

const zoomBefore = await page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-zoom"));
await page.mouse.move(760, 620);
await page.keyboard.down("Control");
await page.mouse.wheel(0, -240);
await page.keyboard.up("Control");
await page.waitForTimeout(400);
const zoomAfter = await page.evaluate(() => document.documentElement.style.getPropertyValue("--editor-zoom"));
const zoomWorks = zoomBefore !== zoomAfter;

await page.locator(".editor-mode-switch button").filter({ hasText: "富文字" }).click();
await page.locator(".ProseMirror.prose-editor").waitFor();
await page.waitForTimeout(700);
const richHtml = await page.locator(".ProseMirror.prose-editor").innerHTML();
const roundTrip = richHtml.includes("<h2") && richHtml.includes("章節標題") && richHtml.includes("<li") && richHtml.includes("<img");
await page.screenshot({ path: path.join(output, "03-rich-roundtrip.png") });

await page.waitForTimeout(1200);
const allCards = await cards();
const saved = allCards.filter((c) => String(c.contentHtml || "").includes("章節標題"));
const persisted = saved.length > 0 && saved.every((c) => /<img\b/.test(String(c.contentHtml)));

const checks = {
  fillsHeight, editorMounted, previewBlocks, inlineImages, viewerOpen, viewerClosed,
  zoomBefore, zoomAfter, zoomWorks, roundTrip, persisted,
};
const failed = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
const results = { ok: failed.length === 0 && errors.length === 0, checks, failures: failed, errors, runAt: new Date().toISOString() };
await fs.writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await browser.close();
process.exitCode = failed.length === 0 && errors.length === 0 ? 0 : 1;
