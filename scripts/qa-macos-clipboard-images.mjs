import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import sharp from "sharp";
import { chromium } from "playwright";

const root = process.cwd();
const releaseDirectory = path.resolve(process.env.CHENGJING_RELEASE_DIR || "release");
const defaultAppPath = path.join(releaseDirectory, "mac-arm64", "澄境.app");
const appPath = resolveAppPath(process.env.CHENGJING_PACKAGED_APP || defaultAppPath);
const executable = resolveExecutable(process.env.CHENGJING_PACKAGED_APP || "", appPath);
const output = path.resolve("qa-artifacts/macos-clipboard-images");
const tempData = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-macos-clipboard-"));
const debugPort = await freePort();
const cardTitle = `剪貼簿圖片封裝驗收-${Date.now()}`;
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
  cwd: root,
  env: {
    ...process.env,
    CHENGJING_SMOKE: "1",
    CHENGJING_SMOKE_USER_DATA: tempData,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });

let browser;
const errors = [];
const report = {
  appPath,
  executable,
  cardTitle,
  fixtures: {},
  paste: {},
  markdown: {},
  persistence: {},
  undo: {},
  rejection: {},
  errors,
};

try {
  if (process.platform !== "darwin") throw new Error("macos-clipboard-qa-requires-darwin");
  if (!(await exists(executable))) throw new Error(`macos-app-not-found:${executable}`);

  await waitForCdp(debugPort, child, 20_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((candidate) => !candidate.url().includes("quick-capture")) || context.pages()[0];
  if (!page) throw new Error("macos-clipboard-qa-page-not-found");
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    // The editor briefly hands TipTap its internal attachment:// reference
    // before replacing it with the native attachment protocol. Chromium logs
    // that transient rejected load even though the final rendered image is
    // valid; keep persistent console errors as failures.
    if (message.type() === "error" && !/^Loading the image 'attachment:\/\//.test(text)) {
      errors.push(`console:${text}`);
    }
  });
  // Keep the daily release check from covering the clipboard workflow.
  await page.evaluate(() => {
    localStorage.setItem("chengjing-last-successful-update-check-day", [
      new Date().getFullYear(),
      String(new Date().getMonth() + 1).padStart(2, "0"),
      String(new Date().getDate()).padStart(2, "0"),
    ].join("-"));
  });
  page.addLocatorHandler(page.locator(".update-backdrop"), async (overlay) => {
    const dismissButton = overlay.locator("button.secondary-button, button.bare-button");
    if (await dismissButton.isVisible().catch(() => false)) await dismissButton.click({ force: true });
  }, { times: 20, noWaitAfter: true });

  await page.locator(".app-shell").waitFor();
  const addCardButton = page.getByRole("button", { name: "新增卡片", exact: true }).first();
  await addCardButton.waitFor();
  await addCardButton.click({ force: true });
  const createModal = page.locator(".unified-create-modal");
  await createModal.waitFor();
  await createModal.locator(".create-card-title").fill(cardTitle);
  await createModal.getByRole("button", { name: /放到卡片庫/ }).click({ force: true });
  await createModal.getByRole("button", { name: "建立卡片", exact: true }).click({ force: true });
  await page.locator(".card-editor-panel").waitFor();

  const card = await waitForCardByTitle(page, cardTitle);
  if (!card) throw new Error("macos-clipboard-qa-card-not-created");

  const fixtures = await createFixtures();
  report.fixtures = Object.fromEntries(fixtures.map((fixture) => [fixture.name, {
    mime: fixture.mime,
    bytes: fixture.bytes.length,
  }]));
  const editor = page.locator(".card-editor-panel .prose-editor");
  await editor.waitFor();
  await editor.click({ force: true });

  const firstPaste = await dispatchClipboardPaste(page, ".card-editor-panel .prose-editor", [fixtures[0]]);
  // Wait for the first async paste to finish inserting and saving its HTML
  // before dispatching the multi-image paste; otherwise the two handlers can
  // legitimately race on the same editor selection.
  const firstState = await waitForCardState(page, card.id, (state) => {
    const inline = state.attachments.filter((item) => state.card.attachmentIds.includes(item.id) && item.role === "inline");
    return inline.length === 1 && state.card.contentHtml.includes(`attachment://${inline[0].id}`);
  });
  const multiPaste = await dispatchClipboardPaste(page, ".card-editor-panel .prose-editor", fixtures.slice(1));
  const expectedImageCount = fixtures.length;
  const pastedState = await waitForCardState(page, card.id, (state) => {
    const inline = state.attachments.filter((item) => state.card.attachmentIds.includes(item.id) && item.role === "inline");
    return inline.length === expectedImageCount && inline.every((item) => state.card.contentHtml.includes(`attachment://${item.id}`));
  });
  const inlineAttachments = pastedState.attachments.filter((item) => pastedState.card.attachmentIds.includes(item.id) && item.role === "inline");
  const inlineIds = inlineAttachments.map((item) => item.id);
  const inlineRefsComplete = inlineIds.every((id) => pastedState.card.contentHtml.includes(`attachment://${id}`));
  const noUnstableImageRefs = !/data:image|chengjing-attachment:|blob:/i.test(pastedState.card.contentHtml);
  await page.waitForFunction((count) => {
    const images = [...document.querySelectorAll(".card-editor-panel .prose-editor img")];
    return images.length === count
      && images.every((image) => image.complete && image.naturalWidth > 0
        && /^(chengjing-attachment:|https:\/\/appassets\.androidplatform\.net\/|blob:)/i.test(image.currentSrc || image.src));
  }, expectedImageCount);
  const visibleImages = await page.locator(".card-editor-panel .prose-editor img").count() === expectedImageCount;
  const svgAttachment = inlineAttachments.find((item) => item.mime === "image/svg+xml");
  const sanitizedSvg = svgAttachment
    ? await page.evaluate(async (relativePath) => {
      const encoded = await window.chengjing.attachments.readData(relativePath);
      return atob(encoded);
    }, svgAttachment.relativePath)
    : "";
  const svgSanitized = Boolean(svgAttachment)
    && !/<script|onload\s*=|onclick\s*=/i.test(sanitizedSvg)
    && /<svg[\s>]/i.test(sanitizedSvg);

  report.paste = {
    firstPastePrevented: firstPaste.defaultPrevented,
    firstPasteItems: firstPaste.itemCount,
    multiPastePrevented: multiPaste.defaultPrevented,
    multiPasteItems: multiPaste.itemCount,
    attachmentCount: inlineAttachments.length,
    attachmentRoles: inlineAttachments.map((item) => item.role),
    attachmentMimes: inlineAttachments.map((item) => item.mime),
    inlineRefsComplete,
    noUnstableImageRefs,
    visibleImages,
    svgSanitized,
  };

  const markdownTab = page.getByRole("tab", { name: "Markdown", exact: true });
  await waitForTabEnabled(page, "Markdown");
  await markdownTab.evaluate((element) => (element instanceof HTMLButtonElement ? element.click() : undefined));
  const markdownInput = page.locator(".markdown-source-input");
  await markdownInput.waitFor();
  await page.waitForFunction((ids) => {
    const value = document.querySelector(".markdown-source-input")?.value || "";
    return ids.every((id) => value.includes(`attachment://${id}`));
  }, inlineIds);
  const markdownValue = await markdownInput.inputValue();
  const markdownRefsComplete = inlineIds.every((id) => markdownValue.includes(`![`) && markdownValue.includes(`attachment://${id}`));
  const markdownImageCount = (markdownValue.match(/!\[[^\]]*]\(attachment:\/\/[^)]+\)/g) || []).length;
  await waitForTabEnabled(page, "富文字");
  await page.getByRole("tab", { name: "富文字", exact: true }).evaluate((element) => (element instanceof HTMLButtonElement ? element.click() : undefined));
  await page.locator(".card-editor-panel .prose-editor").waitFor();
  await page.waitForFunction((count) => document.querySelectorAll(".card-editor-panel .prose-editor img").length === count, expectedImageCount);
  report.markdown = { markdownRefsComplete, markdownImageCount, markdownLength: markdownValue.length };

  await page.locator(".card-back-button").evaluate((element) => (element instanceof HTMLButtonElement ? element.click() : undefined));
  await page.locator(".card-editor-panel").waitFor({ state: "detached" });
  await page.locator(".primary-nav button[aria-label=\"卡片庫\"]").evaluate((element) => (element instanceof HTMLButtonElement ? element.click() : undefined));
  await page.locator(".primary-nav button[aria-label=\"卡片庫\"].is-active").waitFor();
  const libraryCard = page.locator(".library-card").filter({ hasText: cardTitle });
  await libraryCard.waitFor();
  await libraryCard.click({ force: true });
  await page.locator(".card-editor-panel").waitFor();
  await page.waitForFunction((count) => {
    const images = [...document.querySelectorAll(".card-editor-panel .prose-editor img")];
    return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
  }, expectedImageCount);
  const reopenedState = await waitForCardState(page, card.id, (state) => inlineIds.every((id) => state.card.contentHtml.includes(`attachment://${id}`)));
  report.persistence = {
    reopenedImageCount: await page.locator(".card-editor-panel .prose-editor img").count(),
    refsPersisted: inlineIds.every((id) => reopenedState.card.contentHtml.includes(`attachment://${id}`)),
    fileStorage: inlineAttachments.every((item) => item.storage === "file" && Boolean(item.relativePath)),
  };

  const deletedAttachment = inlineAttachments.find((item) => item.name === fixtures[0].name) || inlineAttachments[0];
  const deletedId = deletedAttachment.id;
  const firstImage = page.locator(`.card-editor-panel .prose-editor img[alt="${fixtures[0].name}"]`);
  await firstImage.click({ force: true });
  await page.keyboard.press("Delete");
  await page.evaluate(() => window.dispatchEvent(new Event("chengjing:flush-editors")));
  await page.waitForFunction((count) => {
    const images = [...document.querySelectorAll(".card-editor-panel .prose-editor img")];
    return images.length === count;
  }, expectedImageCount - 1);
  const afterDelete = await waitForCardState(page, card.id, (state) => !state.card.contentHtml.includes(`attachment://${deletedId}`));
  const undoButton = page.locator(".card-editor-panel .rich-editor .editor-toolbar button[aria-label=\"復原\"]");
  await undoButton.evaluate((element) => (element instanceof HTMLButtonElement ? element.click() : undefined));
  await page.evaluate(() => window.dispatchEvent(new Event("chengjing:flush-editors")));
  await page.waitForFunction((count) => document.querySelectorAll(".card-editor-panel .prose-editor img").length === count, expectedImageCount);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new Event("chengjing:flush-editors")));
  const afterUndo = await waitForCardState(page, card.id, (state) => state.card.contentHtml.includes(`attachment://${deletedId}`));
  report.undo = {
    deletedImageCount: expectedImageCount - 1,
    deletePersisted: !afterDelete.card.contentHtml.includes(`attachment://${deletedId}`),
    restoredImageCount: await page.locator(".card-editor-panel .prose-editor img").count(),
    restorePersisted: afterUndo.card.contentHtml.includes(`attachment://${deletedId}`),
  };

  const beforeReject = await readCardState(page, card.id);
  const oversized = {
    name: "too-large.svg",
    mime: "image/svg+xml",
    data: Buffer.alloc(10 * 1024 * 1024 + 1, 0x20).toString("base64"),
  };
  const rejectedPaste = await dispatchClipboardPaste(page, ".card-editor-panel .prose-editor", [oversized]);
  await page.locator(".card-editor-panel .rich-editor .save-state.error").waitFor();
  const afterReject = await waitForCardState(page, card.id, (state) => state.attachments.length === beforeReject.attachments.length);
  const attachmentStats = await page.evaluate(() => window.chengjing.attachments.stats());
  report.rejection = {
    pastePrevented: rejectedPaste.defaultPrevented,
    errorDisplayed: await page.locator(".card-editor-panel .rich-editor .save-state.error").isVisible(),
    cardUnchanged: afterReject.card.contentHtml === beforeReject.card.contentHtml
      && afterReject.card.attachmentIds.join("|") === beforeReject.card.attachmentIds.join("|"),
    attachmentCountUnchanged: afterReject.attachments.length === beforeReject.attachments.length,
    fileCount: attachmentStats.count,
  };

  report.errors = errors;
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  const passed = report.paste.firstPastePrevented
    && report.paste.multiPastePrevented
    && report.paste.attachmentCount === expectedImageCount
    && report.paste.attachmentRoles.every((role) => role === "inline")
    && report.paste.attachmentMimes.includes("image/png")
    && report.paste.attachmentMimes.includes("image/jpeg")
    && report.paste.attachmentMimes.includes("image/webp")
    && report.paste.attachmentMimes.includes("image/svg+xml")
    && report.paste.inlineRefsComplete
    && report.paste.noUnstableImageRefs
    && report.paste.visibleImages
    && report.paste.svgSanitized
    && report.markdown.markdownRefsComplete
    && report.markdown.markdownImageCount === expectedImageCount
    && report.persistence.reopenedImageCount === expectedImageCount
    && report.persistence.refsPersisted
    && report.persistence.fileStorage
    && report.undo.deletePersisted
    && report.undo.restoredImageCount === expectedImageCount
    && report.undo.restorePersisted
    && report.rejection.pastePrevented
    && report.rejection.errorDisplayed
    && report.rejection.cardUnchanged
    && report.rejection.attachmentCountUnchanged
    && errors.length === 0;
  if (!passed) process.exitCode = 1;
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : String(error));
  if (childOutput.trim()) report.errors.push(`child:${childOutput.slice(-2_000)}`);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  if (child.exitCode === null) await waitForExit(child, 3_000);
  await fs.rm(tempData, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 });
}

function resolveAppPath(value) {
  const resolved = path.resolve(value);
  const marker = ".app/";
  const markerIndex = resolved.indexOf(marker);
  if (markerIndex >= 0) return resolved.slice(0, markerIndex + 4);
  return resolved;
}

function resolveExecutable(value, bundlePath) {
  if (value) {
    const resolved = path.resolve(value);
    return resolved.endsWith(".app") ? path.join(resolved, "Contents", "MacOS", "澄境") : resolved;
  }
  return path.join(bundlePath, "Contents", "MacOS", "澄境");
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForCdp(port, processHandle, timeout) {
  const endpoint = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (true) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return;
    } catch {}
    if (Date.now() - started > timeout) {
      throw new Error(`macos-clipboard-qa-launch-timeout:${processHandle.exitCode ?? "running"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function createFixtures() {
  const makeRaster = async (format, color) => {
    const image = sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: { ...color, alpha: 1 },
      },
    });
    return image[format]().toBuffer();
  };
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" onload="alert(1)"><script>alert(2)</script><rect width="12" height="12" fill="#e3a85c" onclick="alert(3)"/></svg>');
  return [
    { name: "pasted-red.png", mime: "image/png", bytes: await makeRaster("png", { r: 214, g: 91, b: 77 }) },
    { name: "pasted-blue.jpg", mime: "image/jpeg", bytes: await makeRaster("jpeg", { r: 65, g: 118, b: 185 }) },
    { name: "pasted-green.webp", mime: "image/webp", bytes: await makeRaster("webp", { r: 76, g: 155, b: 99 }) },
    { name: "pasted-unsafe.svg", mime: "image/svg+xml", bytes: svg },
  ];
}

async function dispatchClipboardPaste(page, selector, inputs) {
  return page.evaluate(({ selector: targetSelector, inputs: imageInputs }) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) throw new Error("clipboard-target-not-found");
    target.focus();
    const transfer = new DataTransfer();
    for (const input of imageInputs) {
      const binary = atob(input.data || uint8ToBase64(input.bytes));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], input.name, { type: input.mime }));
    }
    let event;
    try {
      event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    } catch {
      event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { configurable: false, value: transfer });
    }
    if (!event.clipboardData) Object.defineProperty(event, "clipboardData", { configurable: true, value: transfer });
    const dispatched = target.dispatchEvent(event);
    return {
      dispatched,
      defaultPrevented: event.defaultPrevented,
      itemCount: event.clipboardData?.items?.length || 0,
    };
  }, {
    selector,
    inputs: inputs.map((input) => ({
      name: input.name,
      mime: input.mime,
      data: input.data || Buffer.from(input.bytes).toString("base64"),
    })),
  });
}

async function readCardState(page, cardId) {
  return page.evaluate((id) => new Promise((resolve, reject) => {
    const request = indexedDB.open("chengjing");
    request.onerror = () => reject(request.error || new Error("indexeddb-open-failed"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["cards", "attachments"], "readonly");
      const cardRequest = transaction.objectStore("cards").get(id);
      const attachmentsRequest = transaction.objectStore("attachments").getAll();
      let card;
      let attachments;
      let cardDone = false;
      let attachmentsDone = false;
      const finish = () => {
        if (!cardDone || !attachmentsDone) return;
        database.close();
        resolve({ card, attachments });
      };
      cardRequest.onerror = () => reject(cardRequest.error || new Error("card-read-failed"));
      cardRequest.onsuccess = () => { card = cardRequest.result; cardDone = true; finish(); };
      attachmentsRequest.onerror = () => reject(attachmentsRequest.error || new Error("attachment-read-failed"));
      attachmentsRequest.onsuccess = () => { attachments = attachmentsRequest.result || []; attachmentsDone = true; finish(); };
    };
  }), cardId);
}

async function waitForCardByTitle(page, title, timeout = 15_000) {
  const state = await waitFor(() => page.evaluate((expected) => new Promise((resolve, reject) => {
    const request = indexedDB.open("chengjing");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const query = database.transaction("cards", "readonly").objectStore("cards").getAll();
      query.onerror = () => reject(query.error);
      query.onsuccess = () => {
        database.close();
        resolve(query.result.find((card) => card.title === expected) || null);
      };
    };
  }), title), timeout);
  return state;
}

async function waitForCardState(page, cardId, predicate, timeout = 15_000) {
  return waitFor(async () => {
    const state = await readCardState(page, cardId);
    return predicate(state) ? state : null;
  }, timeout);
}

async function waitFor(read, timeout) {
  const started = Date.now();
  while (true) {
    const result = await read();
    if (result) return result;
    if (Date.now() - started > timeout) throw new Error("macos-clipboard-qa-wait-timeout");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function waitForTabEnabled(page, name, timeout = 15_000) {
  await page.waitForFunction((label) => [...document.querySelectorAll('[role="tab"]')]
    .some((element) => element.textContent?.includes(label) && !(element instanceof HTMLButtonElement && element.disabled)), name, { timeout });
}

function waitForExit(processHandle, timeout) {
  if (processHandle.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function uint8ToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
