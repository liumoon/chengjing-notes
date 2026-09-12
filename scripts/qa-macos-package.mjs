import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { extractFile, listPackage } from "@electron/asar";
import { chromium } from "playwright";

const exec = promisify(execFile);
const root = process.cwd();
const version = JSON.parse(await fs.readFile("package.json", "utf8")).version;
const formal = process.argv.includes("--formal");
const releaseDirectory = path.resolve(process.env.CHENGJING_RELEASE_DIR || "release");
const defaultAppPath = path.join(releaseDirectory, "mac-arm64", "澄境.app");
const defaultDmgPath = path.join(releaseDirectory, `ChengJing-${version}-arm64.dmg`);
const output = path.resolve("qa-artifacts/macos-package");
const appPath = resolveAppPath(process.env.CHENGJING_MAC_APP || process.env.CHENGJING_PACKAGED_APP || defaultAppPath);
const executable = resolveExecutable(process.env.CHENGJING_PACKAGED_APP || "", appPath);
const dmgPath = path.resolve(process.env.CHENGJING_MAC_DMG || defaultDmgPath);
const report = {
  version,
  formal,
  appPath,
  executable,
  dmgPath,
  static: {},
  dmg: {},
  launch: {},
};

await fs.mkdir(output, { recursive: true });

if (process.platform !== "darwin") {
  throw new Error("macos-package-qa-requires-darwin");
}

if (!(await exists(appPath))) throw new Error(`macos-app-not-found:${appPath}`);
if (!(await exists(dmgPath))) throw new Error(`macos-dmg-not-found:${dmgPath}`);
if (!(await exists(executable))) throw new Error(`macos-executable-not-found:${executable}`);

const infoPlist = path.join(appPath, "Contents", "Info.plist");
const asarPath = path.join(appPath, "Contents", "Resources", "app.asar");
if (!(await exists(asarPath))) throw new Error(`macos-asar-not-found:${asarPath}`);
const fileResult = await run("/usr/bin/file", [executable]);
const signatureResult = await run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
const signatureVerifyResult = await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
const executableNameResult = await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlist]);
const asarFiles = listPackage(asarPath);
const packagedMetadata = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
const suspiciousFiles = asarFiles.filter((file) => {
  if (file.includes("/node_modules/")) return false;
  return /(?:oauth.*\.json|client[-_]secret|\.p12$|\.pem$|test[-_](?:oauth|openrouter)|secret\.json)/i.test(file);
});
const signatureText = `${signatureResult.stdout}\n${signatureResult.stderr}`;
const executableName = executableNameResult.stdout.trim();
const fileText = `${fileResult.stdout}\n${fileResult.stderr}`;
const formalSignature = /Authority=Developer ID Application:/.test(signatureText);
const adhocSignature = /Signature=adhoc/.test(signatureText);
const oauthRuntimeBundled = asarFiles.includes("/electron/google-oauth-runtime.cjs");

report.static = {
  appExists: true,
  executableExists: true,
  asarExists: await exists(asarPath),
  versionMatches: packagedMetadata.version === version,
  identifierMatches: /Identifier=tw\.techtarian\.chengjing/.test(signatureText),
  executableName,
  architectureArm64: /\barm64\b/.test(fileText),
  signatureVerified: signatureVerifyResult.passed,
  adHocSignature: adhocSignature,
  developerIdSignature: formalSignature,
  oauthRuntimeBundled,
  suspiciousFiles,
  asarFileCount: asarFiles.length,
};

const mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-dmg-"));
let mounted = false;
try {
  const attach = await run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountPoint, dmgPath], { timeout: 30_000 });
  mounted = attach.passed;
  const mountedApp = path.join(mountPoint, "澄境.app");
  const mountedSignature = mounted
    ? await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", mountedApp])
    : { passed: false };
  report.dmg = {
    exists: true,
    bytes: (await fs.stat(dmgPath)).size,
    sha256: await sha256(dmgPath),
    mounted,
    mountedAppExists: mounted && await exists(mountedApp),
    mountedSignatureVerified: mountedSignature.passed,
    detached: false,
  };
} finally {
  if (mounted) {
    const detach = await run("/usr/bin/hdiutil", ["detach", mountPoint, "-force"], { timeout: 30_000 });
    report.dmg.detached = detach.passed;
  } else {
    report.dmg.detached = true;
  }
  await fs.rm(mountPoint, { recursive: true, force: true });
}

const stapledApp = formal
  ? await run("/usr/bin/xcrun", ["stapler", "validate", appPath], { timeout: 30_000 })
  : { passed: false, stdout: "", stderr: "" };
const stapledDmg = formal
  ? await run("/usr/bin/xcrun", ["stapler", "validate", dmgPath], { timeout: 30_000 })
  : { passed: false, stdout: "", stderr: "" };
report.formalChecks = {
  developerIdSignature: report.static.developerIdSignature,
  oauthRuntimeBundled: report.static.oauthRuntimeBundled,
  appStapled: stapledApp.passed,
  dmgStapled: stapledDmg.passed,
  stapledArtifact: stapledApp.passed ? "app" : stapledDmg.passed ? "dmg" : "",
};

report.launch = await launchSmoke(executable);
await fs.writeFile(path.join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

const staticPassed = report.static.appExists
  && report.static.executableExists
  && report.static.asarExists
  && report.static.versionMatches
  && report.static.identifierMatches
  && report.static.architectureArm64
  && report.static.signatureVerified
  && report.static.suspiciousFiles.length === 0;
const dmgPassed = report.dmg.mounted
  && report.dmg.mountedAppExists
  && report.dmg.mountedSignatureVerified
  && report.dmg.detached;
const launchPassed = report.launch.appShell
  && report.launch.quitBridge
  && report.launch.quickCaptureBridge
  && report.launch.platform === "darwin"
  && report.launch.exited
  && report.launch.errors.length === 0;
const formalPassed = !formal || (
  report.static.developerIdSignature
  && report.static.oauthRuntimeBundled
  && (report.formalChecks.appStapled || report.formalChecks.dmgStapled)
);

if (!staticPassed || !dmgPassed || !launchPassed || !formalPassed) {
  process.exitCode = 1;
}

function resolveAppPath(value) {
  const resolved = path.resolve(value);
  const marker = ".app/";
  const markerIndex = resolved.indexOf(marker);
  if (markerIndex >= 0) return resolved.slice(0, markerIndex + 4);
  return resolved.endsWith(".app") ? resolved : resolved;
}

function resolveExecutable(value, bundlePath) {
  if (value) {
    const resolved = path.resolve(value);
    if (resolved.endsWith(".app")) return path.join(resolved, "Contents", "MacOS", "澄境");
    return resolved;
  }
  return path.join(bundlePath, "Contents", "MacOS", "澄境");
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function run(command, args, options = {}) {
  try {
    const result = await exec(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: options.timeout || 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { passed: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      passed: false,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
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

async function launchSmoke(appExecutable) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-macos-package-"));
  const port = await freePort();
  const child = spawn(appExecutable, [`--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, CHENGJING_SMOKE: "1", CHENGJING_SMOKE_USER_DATA: userData },
    stdio: ["ignore", "ignore", "ignore"],
  });
  let browser;
  const result = { appShell: false, quitBridge: false, quickCaptureBridge: false, platform: "", exited: false, errors: [] };
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const startedAt = Date.now();
    while (true) {
      try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break;
      } catch {}
      if (Date.now() - startedAt > 20_000) return { ...result, errors: ["launch-timeout"] };
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => !candidate.url().includes("quick-capture")) || context.pages()[0];
    if (!page) {
      page = await context.waitForEvent("page", { timeout: 10_000 });
    }
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => result.errors.push(`pageerror:${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") result.errors.push(`console:${message.text()}`);
    });
    if (page.url().includes("quick-capture")) {
      await page.evaluate(() => window.chengjing.quickCapture.showMain());
      page = context.pages().find((candidate) => !candidate.url().includes("quick-capture")) || page;
    }
    await page.locator(".app-shell").waitFor();
    const bridge = await page.evaluate(async () => {
      const system = await window.chengjing.app.getSystemVersion?.();
      return {
      platform: system?.platform || "",
      quitBridge: typeof window.chengjing.app.quit === "function",
      quickCaptureBridge: typeof window.chengjing.quickCapture?.show === "function",
      };
    });
    result.appShell = true;
    result.platform = bridge.platform;
    result.quitBridge = bridge.quitBridge;
    result.quickCaptureBridge = bridge.quickCaptureBridge;
    await page.evaluate(() => window.chengjing.app.quit());
    result.exited = await waitForExit(child, 5_000);
    return result;
  } catch (error) {
    result.errors.push(`launch:${error.message}`);
    return result;
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await waitForExit(child, 3_000);
    await fs.rm(userData, { recursive: true, force: true });
  }
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
