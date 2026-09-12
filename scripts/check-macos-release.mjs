import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const oauthService = "tw.techtarian.chengjing.google-oauth-build";
const oauthAccount = "chengjing-desktop-oauth";
const notaryProfile = String(process.env.CHENGJING_NOTARY_PROFILE || "").trim();
const runtimePath = path.resolve("electron/google-oauth-runtime.cjs");
const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout || 20_000,
    });
    return { passed: true, stdout };
  } catch (error) {
    return { passed: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

if (process.platform !== "darwin") {
  addCheck("macOS host", false, "正式 macOS 發佈檢查只能在 macOS 執行。");
} else {
  const systemVersion = run("/usr/bin/sw_vers", ["-productVersion"]).stdout.trim() || "unknown";
  addCheck("macOS host", true, `darwin ${systemVersion}`);
}

addCheck(
  "Apple Silicon build host",
  process.platform === "darwin" && process.arch === "arm64",
  process.platform === "darwin" ? `process.arch=${process.arch}` : `process.platform=${process.platform}`,
);

const identity = process.platform === "darwin"
  ? run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"])
  : { passed: false, stdout: "" };
const hasDeveloperId = identity.passed && /Developer ID Application:/.test(identity.stdout);
addCheck(
  "Developer ID Application certificate",
  hasDeveloperId,
  hasDeveloperId ? "已找到 Developer ID Application identity。" : "找不到有效的 Developer ID Application identity。",
);

const envOAuthAvailable = Boolean(String(process.env.CHENGJING_GOOGLE_OAUTH_CLIENT_SECRET || "").trim());
const keychainOAuth = process.platform === "darwin"
  ? run("/usr/bin/security", ["find-generic-password", "-s", oauthService, "-a", oauthAccount])
  : { passed: false };
const oauthAvailable = envOAuthAvailable || keychainOAuth.passed;
addCheck(
  "Google OAuth build credential",
  oauthAvailable,
  envOAuthAvailable ? "由 CHENGJING_GOOGLE_OAUTH_CLIENT_SECRET 提供。" : keychainOAuth.passed ? "已在 macOS 鑰匙圈找到建置憑證。" : "找不到 OAuth 建置憑證；請先匯入桌面 OAuth client JSON。",
);

const runtimeTracked = run("git", ["ls-files", "--error-unmatch", "electron/google-oauth-runtime.cjs"]).passed;
addCheck(
  "Generated OAuth runtime is not tracked",
  !runtimeTracked,
  runtimeTracked ? "electron/google-oauth-runtime.cjs 不得提交到 Git。" : "檔案未被 Git 追蹤。",
);

const runtimeExists = await fs.access(runtimePath).then(() => true).catch(() => false);
let runtimePermissionsSafe = true;
if (runtimeExists) {
  const mode = (await fs.stat(runtimePath)).mode & 0o777;
  runtimePermissionsSafe = (mode & 0o077) === 0;
  addCheck(
    "Generated OAuth runtime permissions",
    runtimePermissionsSafe,
    runtimePermissionsSafe ? "runtime 檔案只允許擁有者讀寫。" : `runtime 檔案權限過寬：${mode.toString(8)}`,
  );
} else {
  addCheck("Generated OAuth runtime permissions", true, "建置時會從已驗證的 credential 產生 runtime 檔案；目前工作區沒有該檔案。");
}

const notaryTool = process.platform === "darwin"
  ? run("/usr/bin/xcrun", ["--find", "notarytool"])
  : { passed: false };
addCheck(
  "xcrun notarytool",
  notaryTool.passed,
  notaryTool.passed ? "xcrun notarytool 可用。" : "找不到 xcrun notarytool。",
);

let notaryProfileValid = false;
if (notaryProfile && notaryTool.passed) {
  const result = run("/usr/bin/xcrun", [
    "notarytool",
    "history",
    "--keychain-profile",
    notaryProfile,
    "--output-format",
    "json",
  ], { timeout: 30_000 });
  notaryProfileValid = result.passed;
}
addCheck(
  "notarytool keychain profile",
  notaryProfileValid,
  notaryProfile
    ? (notaryProfileValid ? "notarytool profile 可用。" : "notarytool profile 無法驗證；請確認 profile、Apple 帳號與網路。")
    : "未設定 CHENGJING_NOTARY_PROFILE。",
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
}

console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  notaryProfileConfigured: Boolean(notaryProfile),
  oauthRuntimePresent: runtimeExists,
  checks,
}, null, 2));

if (failures.length) {
  console.error(`macOS release preflight failed: ${failures.length} check(s) did not pass.`);
  process.exitCode = 1;
}
