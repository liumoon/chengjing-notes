// 真機驗收：自簽 HTTPS LiteLLM Gateway 的「核對指紋 → 信任 → 連線 → 撤銷」全流程。
// 用法：node scripts/qa-provider-cert-trust.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { chromium } from "playwright";

const root = process.cwd();
const executable = path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const tempData = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-cert-qa-"));
const tempCerts = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-cert-qa-certs-"));
const debugPort = await freePort();
const MODEL = "qwen3:8b";
const errors = [];
const report = { steps: [], errors };

function ok(name, condition, detail = "") {
  report.steps.push({ name, pass: Boolean(condition), detail: String(detail).slice(0, 220) });
  if (!condition) errors.push(`${name}${detail ? ` :: ${detail}` : ""}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function selfSigned(name) {
  const key = path.join(tempCerts, `${name}-key.pem`);
  const cert = path.join(tempCerts, `${name}-cert.pem`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "2", "-nodes", "-subj", `/CN=${name}.litellm.local`, "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  const pem = await fs.readFile(cert, "utf8");
  const fingerprint = execFileSync("openssl", ["x509", "-in", cert, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" }).split("=")[1].trim().replace(/:/g, "").toUpperCase();
  return { key: await fs.readFile(key), cert: await fs.readFile(cert), fingerprint, pem };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

const gateway = await selfSigned("primary");
const other = await selfSigned("other");
const modelsPayload = JSON.stringify({ object: "list", data: [{ id: MODEL, name: "Qwen3 8B" }] });
const gatewayServer = https.createServer({ key: gateway.key, cert: gateway.cert }, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(modelsPayload); });
const otherServer = https.createServer({ key: other.key, cert: other.cert }, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(modelsPayload); });
const gatewayPort = await listen(gatewayServer);
const otherPort = await listen(otherServer);
// 純 HTTP 伺服器：用來確認「未信任的明文服務」不會被憑證信任機制誤放行。
const plainServer = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(modelsPayload); });
const plainPort = await listen(plainServer);
const gatewayUrl = `https://127.0.0.1:${gatewayPort}/v1`;
const otherUrl = `https://127.0.0.1:${otherPort}/v1`;

const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, "."], {
  cwd: root,
  env: { ...process.env, CHENGJING_SMOKE: "1", CHENGJING_SMOKE_USER_DATA: tempData },
  stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });

let browser;
try {
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 45_000;
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${debugPort}/json/version`, (res) => { res.resume(); resolve(); });
      req.on("error", () => (Date.now() > deadline ? reject(new Error("cdp-unavailable")) : setTimeout(tick, 400)));
    };
    setTimeout(tick, 1_200);
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  await context.waitForEvent("page", { timeout: 20_000 }).catch(() => null);
  const pages = context.pages().filter((item) => /index\.html(\?|$)/.test(item.url()));
  const page = pages.find((item) => !item.url().includes("quick-capture")) || pages[0];
  if (!page) throw new Error("electron-main-window-not-found");
  await page.waitForFunction(() => Boolean(window.chengjing?.ai?.upsertProvider), null, { timeout: 30_000 });
  const bridge = {
    upsert: (input) => page.evaluate((value) => window.chengjing.ai.upsertProvider(value), input),
    test: (id) => page.evaluate((value) => window.chengjing.ai.testProvider(value), id),
    models: (id) => page.evaluate((value) => window.chengjing.ai.listProviderModels(value), id),
    remove: (id) => page.evaluate((value) => window.chengjing.ai.removeProvider(value), id),
    providerSettings: () => page.evaluate(() => window.chengjing.ai.providerSettings()),
  };
  const base = { name: "QA LiteLLM 自簽", type: "openai-compatible", apiMode: "chat-completions", model: MODEL };

  let settings = await bridge.upsert({ ...base, baseUrl: gatewayUrl, select: true });
  const id = settings.profiles[0].id;
  ok("建立未信任的自簽 Provider", settings.profiles.length === 1 && !settings.profiles[0].certFingerprint, id);

  let result = await bridge.test(id);
  ok("未信任時 TLS 握手被拒（stage=certificate）", result.ok === false && result.diagnostics?.stage === "certificate", JSON.stringify(result.diagnostics || {}));
  ok("診斷回傳可核對的憑證指紋", String(result.diagnostics?.certFingerprint || "").toUpperCase() === gateway.fingerprint, `${result.diagnostics?.certFingerprint} vs ${gateway.fingerprint}`);
  ok("診斷一併帶回 PEM 與簽發者", String(result.diagnostics?.certPem || "").startsWith("-----BEGIN CERTIFICATE-----") && Boolean(result.diagnostics?.certIssuer), `${String(result.diagnostics?.certPem).slice(0, 27)} / ${result.diagnostics?.certIssuer}`);
  ok("未信任時不取得模型", Array.isArray(result.models) && result.models.length === 0, String(result.models?.length));
  const hint = result.diagnostics || {};

  await bridge.upsert({ id, ...base, baseUrl: gatewayUrl, certFingerprint: "A".repeat(64), certPem: hint.certPem, select: true });
  result = await bridge.test(id);
  ok("指紋與憑證不符時不放行", result.ok === false && result.diagnostics?.stage === "certificate", JSON.stringify(result.diagnostics || {}));
  settings = await bridge.providerSettings();
  ok("不符的指紋不會被保存", !settings.profiles[0].certFingerprint && !settings.profiles[0].certPem, JSON.stringify({ fp: settings.profiles[0].certFingerprint, pem: Boolean(settings.profiles[0].certPem) }));

  settings = await bridge.upsert({ id, ...base, baseUrl: gatewayUrl, certFingerprint: gateway.fingerprint, certPem: gateway.pem, select: true });
  ok("保存成對的指紋與憑證", settings.profiles[0].certFingerprint === gateway.fingerprint && Boolean(settings.profiles[0].certPem), String(settings.profiles[0].certFingerprint));
  result = await bridge.test(id);
  ok("信任後成功連線並取得模型", result.ok === true && result.models.some((item) => item.id === MODEL), JSON.stringify({ ok: result.ok, stage: result.diagnostics?.stage, models: result.models.map((item) => item.id) }));
  const listed = await bridge.models(id);
  ok("取得模型清單同樣走放行通道", listed.some((item) => item.id === MODEL), JSON.stringify(listed.map((item) => item.id)));

  settings = await bridge.upsert({ id, ...base, baseUrl: otherUrl, select: true });
  ok("換到另一台服務後信任自動失效", settings.profiles[0].certFingerprint === "" && !settings.profiles[0].certPem, JSON.stringify({ fp: settings.profiles[0].certFingerprint, pem: Boolean(settings.profiles[0].certPem) }));
  result = await bridge.test(id);
  ok("信任不可跨來源套用", result.ok === false && result.diagnostics?.stage === "certificate", JSON.stringify(result.diagnostics || {}));
  ok("另一台出示的是不同憑證", String(result.diagnostics?.certFingerprint || "").toUpperCase() === other.fingerprint, `${result.diagnostics?.certFingerprint} vs ${other.fingerprint}`);

  settings = await bridge.upsert({ id, ...base, baseUrl: gatewayUrl, select: true });
  result = await bridge.test(id);
  ok("失效後不會自己復活", result.ok === false && result.diagnostics?.stage === "certificate", JSON.stringify(result.diagnostics || {}));
  settings = await bridge.upsert({ id, ...base, baseUrl: gatewayUrl, certFingerprint: gateway.fingerprint, certPem: gateway.pem, select: true });
  result = await bridge.test(id);
  ok("重新核對指紋後再次連線成功", result.ok === true, JSON.stringify(result.diagnostics || {}));

  settings = await bridge.upsert({ id, ...base, baseUrl: gatewayUrl, certFingerprint: "", select: true });
  ok("可明確撤銷信任", !settings.profiles[0].certFingerprint && !settings.profiles[0].certPem, JSON.stringify({ fp: settings.profiles[0].certFingerprint, pem: Boolean(settings.profiles[0].certPem) }));
  result = await bridge.test(id);
  ok("撤銷後恢復嚴格驗證", result.ok === false && result.diagnostics?.stage === "certificate", JSON.stringify(result.diagnostics || {}));

  settings = await bridge.upsert({ id, ...base, baseUrl: `http://127.0.0.1:${plainPort}/v1`, certFingerprint: "", select: true });
  result = await bridge.test(id);
  ok("私有網段 HTTP 不受憑證機制影響", result.ok === true, JSON.stringify(result.diagnostics || {}));

  settings = await bridge.upsert({ id, ...base, baseUrl: gatewayUrl, select: true });
  ok("從 HTTP 切回 HTTPS 時清除舊 origin 的信任", settings.profiles[0].certFingerprint === "" && !settings.profiles[0].certPem, JSON.stringify({ fp: settings.profiles[0].certFingerprint, pem: Boolean(settings.profiles[0].certPem) }));
  result = await bridge.test(id);
  ok("切回 HTTPS 後必須重新核對憑證", result.ok === false && result.diagnostics?.stage === "certificate", JSON.stringify(result.diagnostics || {}));
  settings = await bridge.upsert({ id, ...base, baseUrl: gatewayUrl, certFingerprint: gateway.fingerprint, certPem: gateway.pem, select: true });
  result = await bridge.test(id);
  ok("重新核對後 HTTPS 恢復連線", result.ok === true, JSON.stringify(result.diagnostics || {}));

  const trustCopyTitle = "信任這個伺服器憑證";
  const trustCopyRevoke = "撤銷憑證信任";

  // UI 層：先清乾淨並重載，確保表單狀態沒有沿用前面的信任，才驗得出「第一次要求信任」。
  page.on("dialog", (dialog) => void dialog.accept());
  for (const profile of (await bridge.providerSettings()).profiles) await bridge.remove(profile.id);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.chengjing?.ai?.upsertProvider), null, { timeout: 30_000 });
  const settingsButton = page.getByRole("button", { name: "設定", exact: true });
  await settingsButton.evaluate((element) => element.scrollIntoView({ block: "center" })).catch(() => {});
  await settingsButton.click({ timeout: 15_000 }).catch(async () => { await settingsButton.evaluate((element) => element.click()); });
  await page.waitForSelector(".settings-jump-nav", { timeout: 15_000 });
  const jumpNav = page.locator(".settings-jump-nav");
  await jumpNav.waitFor();
  await jumpNav.getByRole("link", { name: "AI", exact: true }).evaluate((element) => element.click());
  const provider = page.locator(".advanced-provider");
  await provider.waitFor();
  if (!(await provider.evaluate((element) => element.open))) await provider.locator("> summary").evaluate((element) => element.click());
  await provider.locator(".provider-type-choice button").nth(1).evaluate((element) => element.click());
  const fields = provider.locator(".provider-field-grid label");
  await fields.nth(0).locator("input").fill("UI 自簽 LiteLLM");
  await fields.nth(1).locator("input").fill(MODEL);
  await provider.locator(".provider-wide-field input").first().fill(gatewayUrl);
  await provider.locator('.provider-form button[type="submit"]').evaluate((element) => element.click());
  await page.waitForTimeout(900);
  await provider.locator(".provider-form .secondary-button").last().evaluate((element) => element.click());
  await page.waitForTimeout(2_500);
  await provider.locator(".provider-cert-trust").waitFor({ timeout: 25_000 });
  const panelText = await provider.locator(".provider-cert-trust").innerText();
  ok("UI 出現自簽憑證信任面板", panelText.includes(trustCopyTitle), panelText.slice(0, 90).replace(/\s+/g, " "));
  ok("UI 顯示分組可读的憑證指紋", panelText.includes(gateway.fingerprint.match(/.{2}/g).join(":")), panelText.replace(/\s+/g, " ").slice(-120));
  ok("UI 顯示簽發者與有效期限", panelText.includes("primary.litellm.local"), panelText.replace(/\s+/g, " ").slice(0, 160));
  await provider.locator(".provider-cert-trust").screenshot({ path: path.resolve("qa-artifacts/provider-cert-trust/ui-trust-panel.png") });
  await provider.locator(".provider-cert-trust button").evaluate((element) => element.click());
  await provider.locator(".provider-diagnostic.is-ok").waitFor({ timeout: 25_000 });
  ok("UI 點信任後顯示連線成功", (await provider.locator(".provider-diagnostic.is-ok").isVisible()), "diagnostic is-ok");
  ok("UI 模型下拉出現取回的模型", (await provider.locator("#provider-model-options option").count()) > 0, String(await provider.locator("#provider-model-options option").count()));
  await provider.locator(".provider-profile-list article").filter({ hasText: "UI 自簽 LiteLLM" }).locator(".provider-cert-badge").waitFor({ timeout: 10_000 });
  ok("UI 連線列表標示已信任自簽憑證", true, "badge visible");
  await provider.locator(".provider-form > footer button").filter({ hasText: trustCopyRevoke }).evaluate((element) => element.click());
  await page.waitForTimeout(1_200);
  await provider.locator(".provider-form .secondary-button").last().evaluate((element) => element.click());
  await provider.locator(".provider-cert-trust").waitFor({ timeout: 25_000 });
  ok("UI 撤銷後再次要求信任", true, "panel returned after revoke");

  const finalSettings = await bridge.providerSettings();
  for (const profile of finalSettings.profiles) await bridge.remove(profile.id);
  const after = await page.evaluate(() => window.chengjing.ai.providerSettings());
  ok("清理 QA Provider", after.profiles.length === 0, String(after.profiles.length));
  ok("App 端無未預期錯誤", !/certificate-error|Uncaught|FATAL/i.test(childOutput.replace(/ERR_CERT_AUTHORITY_INVALID/g, "")), childOutput.slice(-260));
} catch (error) {
  errors.push(`fatal :: ${error?.message || error}`);
} finally {
  report.errors = errors;
  report.ok = errors.length === 0;
  await fs.mkdir(path.resolve("qa-artifacts/provider-cert-trust"), { recursive: true });
  await fs.writeFile(path.resolve("qa-artifacts/provider-cert-trust/report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.resolve("qa-artifacts/provider-cert-trust/electron.log"), childOutput, "utf8");
  console.log(JSON.stringify(report, null, 2));
  await close(gatewayServer); await close(otherServer); await close(plainServer);
  await browser?.close().catch(() => {});
  child.kill("SIGTERM");
  await fs.rm(tempData, { recursive: true, force: true });
  await fs.rm(tempCerts, { recursive: true, force: true });
  process.exit(report.ok ? 0 : 1);
}
