const assert = require("node:assert/strict");
const test = require("node:test");
const https = require("node:https");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  formatCertFingerprint,
  hostnameOf,
  isCertificateAllowed,
  isTlsFailure,
  normalizeCertFingerprint,
  pinnedHttpsFetch,
  pinnedFingerprintForTarget,
  readPeerCertificate,
} = require("./cert-trust.cjs");

async function selfSignedFixture(root, name) {
  const keyPath = path.join(root, `${name}-key.pem`);
  const certPath = path.join(root, `${name}-cert.pem`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", `/CN=${name}.litellm.test`, "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  const cert = await fs.readFile(certPath);
  const key = await fs.readFile(keyPath);
  const pem = cert.toString("utf8");
  const fingerprint = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" }).split("=")[1].trim().replace(/:/g, "").toUpperCase();
  return { key, cert, pem, fingerprint };
}

function listenOn(server) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
}

function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }

const fsSync = require("node:fs");
const fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "chengjing-cert-unit-"));
function selfSignedSync(root, name) {
  const keyPath = path.join(root, `${name}-key.pem`);
  const certPath = path.join(root, `${name}-cert.pem`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", `/CN=${name}.litellm.test`, "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  const pem = fsSync.readFileSync(certPath, "utf8");
  return { pem, fingerprint: execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" }).split("=")[1].trim().replace(/:/g, "").toUpperCase() };
}
const fixture = selfSignedSync(fixtureRoot, "unit");
const FP = fixture.fingerprint;
const PEM = fixture.pem;
const COLONS = FP.match(/.{2}/g).join(":");
process.on("exit", () => { try { fsSync.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* 暫存目錄由系統回收 */ } });

test("指紋正規化只接受 64 位元十六進位", () => {
  assert.equal(normalizeCertFingerprint(COLONS), FP);
  assert.equal(normalizeCertFingerprint(FP.toLowerCase()), FP);
  assert.equal(normalizeCertFingerprint(`  ${FP}  `), FP);
  assert.equal(normalizeCertFingerprint(FP.toLowerCase().replace(/(.{2})/g, "$1 ")), FP);
  assert.equal(normalizeCertFingerprint(FP.slice(0, 63)), "");
  assert.equal(normalizeCertFingerprint(FP + "AB"), "");
  assert.equal(normalizeCertFingerprint("not-a-fingerprint"), "");
  assert.equal(normalizeCertFingerprint(undefined), "");
  assert.equal(normalizeCertFingerprint(null), "");
  assert.equal(formatCertFingerprint(FP), COLONS);
  assert.equal(formatCertFingerprint("bad"), "");
});

test("主機解析與 URL 邊界", () => {
  assert.equal(hostnameOf("https://10.0.10.60:8443/v1/models"), "10.0.10.60");
  assert.equal(hostnameOf("https://LiteLLM.Local/v1/"), "litellm.local");
  assert.equal(hostnameOf("https://[fd00::10]:8443/v1"), "fd00::10");
  assert.equal(hostnameOf("not a url"), "");
  assert.equal(hostnameOf(""), "");
});

test("TLS 錯誤辨識：只認憑證類錯誤", () => {
  for (const code of [
    "net::ERR_CERT_AUTHORITY_INVALID",
    "net::ERR_CERT_COMMON_NAME_INVALID",
    "net::ERR_CERT_DATE_INVALID",
    "net::ERR_CERT_REVOKED",
    "net::ERR_SSL_PROTOCOL_ERROR",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "unable to get local issuer certificate",
    "certificate has expired",
    "ERR_CERT_VERIFY_FAILED",
  ]) assert.equal(isTlsFailure(code), true, code);
  for (const code of [
    "provider-timeout",
    "provider-http-401",
    "provider-http-404",
    "provider-model-required",
    "fetch failed",
    "",
    undefined,
  ]) assert.equal(isTlsFailure(code), false, String(code));
});

test("憑證放行需主機與指紋同時相符", () => {
  const profiles = [{ id: "litellm01", baseUrl: "https://10.0.10.60:8443/v1", certFingerprint: FP }];
  assert.equal(isCertificateAllowed(profiles, "https://10.0.10.60:8443/v1/models", COLONS), true);
  assert.equal(isCertificateAllowed(profiles, "https://10.0.10.60:8443/v1/chat/completions", FP.toLowerCase()), true);
  assert.equal(isCertificateAllowed(profiles, "https://10.0.10.61:8443/v1/models", COLONS), false);
  assert.equal(isCertificateAllowed(profiles, "https://10.0.10.60:8443/v1/models", "A".repeat(64)), false);
  assert.equal(isCertificateAllowed(profiles, "https://10.0.10.60:8443/v1/models", ""), false);
  assert.equal(isCertificateAllowed(profiles, "http://10.0.10.60:8443/v1/models", COLONS), true);
  assert.equal(isCertificateAllowed([], "https://10.0.10.60:8443/v1/models", COLONS), false);
  assert.equal(isCertificateAllowed([{ id: "x", baseUrl: "https://a.test/v1" }], "https://a.test/v1", COLONS), false);
  assert.deepEqual(pinnedFingerprintForTarget(profiles, "https://10.0.10.60:8443/v1")?.id, "litellm01");
  assert.equal(pinnedFingerprintForTarget(profiles, "https://other.test/v1"), null);
});

test("讀取自我簽章憑證指紋並與 openssl 一致", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-cert-test-"));
  const keyPath = path.join(root, "key.pem");
  const certPath = path.join(root, "cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", "/CN=litellm.test", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    const server = https.createServer({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) }, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [] })); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    try {
      const peer = await readPeerCertificate(`https://127.0.0.1:${port}/v1/models`);
      assert.equal(peer.hostname, "127.0.0.1");
      assert.equal(peer.port, port);
      assert.equal(peer.authorized, false);
      assert.match(peer.authorizationError, /SELF_SIGNED|self[- ]signed/i);
      const expected = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" }).split("=")[1].trim().replace(/:/g, "").toUpperCase();
      assert.equal(peer.fingerprint, expected);
      assert.equal(normalizeCertFingerprint(peer.fingerprint), expected);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readPeerCertificate 只接受 https 且無憑證時明確失敗", async () => {
  await assert.rejects(() => readPeerCertificate("http://127.0.0.1:1/v1"), /cert-target-invalid/);
  await assert.rejects(() => readPeerCertificate("https://user:pass@127.0.0.1:1/v1"), /cert-target-invalid/);
  await assert.rejects(() => readPeerCertificate("not-a-url"), /cert-target-invalid/);
  await assert.rejects(() => readPeerCertificate("https://127.0.0.1:1/v1"), /cert-|ECONNREFUSED|refused|timeout/i);
});

test("憑證信任需指紋與 PEM 成對吻合，並隨 origin 失效", async () => {
  const { normalizeProfile, upsertProviderProfile, readProviderSettings, removeProviderProfile } = require("./provider-settings.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-cert-profile-"));
  try {
    // 只是指紋、沒有憑證：不成對，不生效。
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen3:8b", certFingerprint: FP }).certFingerprint, "");
    // 指紋與憑證不符：不生效也不保存。
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen3:8b", certFingerprint: "A".repeat(64), certPem: PEM }).certFingerprint, "");
    // 成對吻合：生效。
    const pinned = normalizeProfile({ id: "litellm01", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen3:8b", certFingerprint: FP, certPem: PEM });
    assert.equal(pinned.certFingerprint, FP);
    assert.match(pinned.certPem, /-----BEGIN CERTIFICATE-----/);
    // 沒帶憑證欄位且同一 origin：沿用。
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen2.5:7b" }, pinned).certFingerprint, FP);
    // 換主機／換埠／換協定：一律失效，不沿用舊信任。
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://litellm.other.test/v1", model: "qwen3:8b" }, pinned).certFingerprint, "");
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://10.0.10.60:9443/v1", model: "qwen3:8b" }, pinned).certFingerprint, "");
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "http://10.0.10.60:8443/v1", model: "qwen3:8b" }, pinned).certFingerprint, "");
    // 明確傳空字串＝撤銷。
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen3:8b", certFingerprint: "" }, pinned).certFingerprint, "");
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen3:8b", certPem: "" }, pinned).certPem, "");

    let settings = await upsertProviderProfile(root, { name: "Lab LiteLLM", type: "openai-compatible", apiMode: "chat-completions", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen3:8b", certFingerprint: FP, certPem: PEM });
    assert.equal(settings.profiles[0].certFingerprint, FP);
    assert.equal((await readProviderSettings(root)).profiles[0].certFingerprint, FP, "重開 App 後仍保有信任");
    settings = await upsertProviderProfile(root, { id: settings.profiles[0].id, name: "Lab LiteLLM", type: "openai-compatible", apiMode: "chat-completions", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen2.5:7b" });
    assert.equal(settings.profiles[0].certFingerprint, FP, "改模型不該洗掉信任");
    settings = await upsertProviderProfile(root, { id: settings.profiles[0].id, name: "Lab LiteLLM", type: "openai-compatible", apiMode: "chat-completions", baseUrl: "https://10.0.10.60:8443/v1", model: "qwen2.5:7b", certFingerprint: "", certPem: "" });
    assert.equal(settings.profiles[0].certFingerprint, "", "應可明確撤銷信任");
    await removeProviderProfile(root, settings.profiles[0].id);
    assert.equal((await readProviderSettings(root)).profiles.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pinnedHttpsFetch 用核准過的憑證完成真實 TLS 請求", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-pinned-fetch-"));
  try {
    const { key, cert, pem, fingerprint } = await selfSignedFixture(root, "pinned");
    const payload = JSON.stringify({ object: "list", data: [{ id: "qwen3:8b" }] });
    const server = https.createServer({ key, cert }, (_req, res) => { res.writeHead(200, { "Content-Type": "application/json", "X-QA": "yes" }); res.end(payload); });
    const port = await listenOn(server);
    try {
      const res = await pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: pem }, { method: "GET" });
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(res.headers.get("x-qa"), "yes");
      assert.equal(await res.text(), payload);
      const posted = await pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/chat/completions`, { certFingerprint: fingerprint, certPem: pem }, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "qwen3:8b" }) });
      assert.equal(posted.status, 200);
      await assert.rejects(() => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: "B".repeat(64), certPem: pem }, {}), /ERR_CERT_AUTHORITY_INVALID/);
      await assert.rejects(() => pinnedHttpsFetch(`http://127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: pem }, {}), /cert-target-invalid/);
      await assert.rejects(() => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: "" }, {}), /cert-pin-missing/);
      const other = await selfSignedFixture(root, "other");
      await assert.rejects(() => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: other.fingerprint, certPem: other.pem }, {}), /ERR_CERT_AUTHORITY_INVALID/);
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});