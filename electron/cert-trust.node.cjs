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
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", `/CN=${name}.litellm.test`, "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,digitalSignature"], { stdio: "ignore" });
  const cert = await fs.readFile(certPath);
  const key = await fs.readFile(keyPath);
  const pem = cert.toString("utf8");
  const fingerprint = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" }).split("=")[1].trim().replace(/:/g, "").toUpperCase();
  return { key, cert, pem, fingerprint };
}

async function expiredSelfSignedFixture(root, name) {
  const keyPath = path.join(root, `${name}-key.pem`);
  const requestPath = path.join(root, `${name}-request.pem`);
  const certPath = path.join(root, `${name}-cert.pem`);
  const configPath = path.join(root, `${name}-openssl.cnf`);
  const databasePath = path.join(root, `${name}-index.txt`);
  const serialPath = path.join(root, `${name}-serial`);
  const newCertsDirectory = path.join(root, `${name}-newcerts`);
  await fs.mkdir(newCertsDirectory);
  await fs.writeFile(databasePath, "");
  await fs.writeFile(serialPath, "01\n");
  await fs.writeFile(configPath, `[ ca ]
default_ca = local_ca
[ local_ca ]
database = ${databasePath}
new_certs_dir = ${newCertsDirectory}
serial = ${serialPath}
default_md = sha256
policy = policy_any
x509_extensions = ext
[ policy_any ]
commonName = supplied
[ ext ]
subjectAltName = IP:127.0.0.1,DNS:localhost
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature
`);
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", requestPath, "-nodes", "-subj", `/CN=${name}.litellm.test`], { stdio: "ignore" });
  execFileSync("openssl", ["ca", "-config", configPath, "-selfsign", "-batch", "-notext", "-keyfile", keyPath, "-in", requestPath, "-out", certPath, "-startdate", "20200101000000Z", "-enddate", "20200102000000Z"], { stdio: "ignore" });
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
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", `/CN=${name}.litellm.test`, "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,digitalSignature"], { stdio: "ignore" });
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
  assert.equal(isCertificateAllowed(profiles, "http://10.0.10.60:8443/v1/models", COLONS), false);
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
    assert.equal(normalizeProfile({ id: "litellm01", baseUrl: "https://litellm.other.test/v1", model: "qwen3:8b", certFingerprint: FP, certPem: PEM }, pinned).certFingerprint, "", "換來源時不可沿用 renderer 仍保留的舊 pin");
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
    let requestCount = 0;
    let bodyBytes = 0;
    let secureConnectionCount = 0;
    const server = https.createServer({ key, cert }, (req, res) => {
      requestCount += 1;
      req.on("data", (chunk) => { bodyBytes += chunk.length; });
      req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json", "X-QA": "yes" }); res.end(payload); });
    });
    server.on("secureConnection", () => { secureConnectionCount += 1; });
    const port = await listenOn(server);
    try {
      const res = await pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: pem }, { method: "GET" });
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(res.headers.get("x-qa"), "yes");
      assert.equal(await res.text(), payload);
      const posted = await pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/chat/completions`, { certFingerprint: fingerprint, certPem: pem }, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "qwen3:8b" }) });
      assert.equal(posted.status, 200);
      assert.equal(requestCount, 2);
      assert.equal(secureConnectionCount, 2, "每次請求都應建立新的 TLS 連線");
      const requestsBeforeMismatch = requestCount;
      const bodyBeforeMismatch = bodyBytes;
      await assert.rejects(() => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: "B".repeat(64), certPem: pem }, {}), (error) => error?.code === "cert-invalid");
      await assert.rejects(() => pinnedHttpsFetch(`http://127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: pem }, {}), /cert-target-invalid/);
      await assert.rejects(() => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: "" }, {}), /cert-pin-missing/);
      const other = await selfSignedFixture(root, "other");
      await assert.rejects(() => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: other.fingerprint, certPem: other.pem }, {}), (error) => error?.code === "cert-pin-mismatch" && error.presentedFingerprint === fingerprint);
      await assert.rejects(() => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: pem, origin: `https://127.0.0.1:${port + 1}` }, {}), (error) => error?.code === "cert-target-invalid");
      await assert.rejects(() => pinnedHttpsFetch(`https://user:pass@127.0.0.1:${port}/v1/models`, { certFingerprint: fingerprint, certPem: pem }, {}), /cert-target-invalid/);
      assert.equal(requestCount, requestsBeforeMismatch, "指紋不符時不可送出 HTTP 請求");
      assert.equal(bodyBytes, bodyBeforeMismatch, "指紋不符時不可送出 HTTP body");
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CA:TRUE 但缺少完整 CA 用途的自簽憑證，在明確 pin 下仍可連線", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-ca-true-"));
  try {
    const fixture = await selfSignedFixture(root, "ca-true");
    const server = https.createServer({ key: fixture.key, cert: fixture.cert }, (_req, res) => { res.end("ok"); });
    const port = await listenOn(server);
    try {
      const response = await pinnedHttpsFetch(`https://127.0.0.1:${port}/`, { certFingerprint: fixture.fingerprint, certPem: fixture.pem }, {});
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("已過期自簽憑證即使指紋正確也會拒絕", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-expired-cert-"));
  try {
    const fixture = await expiredSelfSignedFixture(root, "expired");
    const server = https.createServer({ key: fixture.key, cert: fixture.cert }, (_req, res) => { res.end("should-not-be-requested"); });
    const port = await listenOn(server);
    try {
      await assert.rejects(
        () => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, { certFingerprint: fixture.fingerprint, certPem: fixture.pem }, {}),
        (error) => error?.code === "cert-expired" && error.presentedFingerprint === fixture.fingerprint,
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pinnedHttpsFetch 不自動跟隨重新導向，也不送出 body", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-redirect-"));
  try {
    const fixture = await selfSignedFixture(root, "redirect");
    let requestCount = 0;
    let bodyBytes = 0;
    const server = https.createServer({ key: fixture.key, cert: fixture.cert }, (req, res) => {
      requestCount += 1;
      req.on("data", (chunk) => { bodyBytes += chunk.length; });
      req.on("end", () => {
        if (req.url === "/v1/models") {
          res.writeHead(302, { Location: "https://127.0.0.1:1/v1/models" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
      });
    });
    const port = await listenOn(server);
    try {
      const pinned = { certFingerprint: fixture.fingerprint, certPem: fixture.pem };
      const response = await pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, pinned, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"secret":"private-note"}' });
      assert.equal(response.status, 302, "必須把 3xx 原封不動回報，交由上層決定");
      assert.equal(response.ok, false);
      assert.equal(response.headers.get("location"), `https://127.0.0.1:1/v1/models`);
      assert.equal(requestCount, 1, "pinned 通道不得自行跟隨重新導向");
      assert.equal(bodyBytes, '{"secret":"private-note"}'.length);
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pinnedHttpsFetch 正確組裝 chunked 回應並在中止時回報逾時", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chengjing-chunked-"));
  try {
    const fixture = await selfSignedFixture(root, "chunked");
    const server = https.createServer({ key: fixture.key, cert: fixture.cert }, (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"object":');
      res.write('"list","data":');
      res.end("[{\"id\":\"omlx-qwen38-flash-oq4e\"}]}");
    });
    const port = await listenOn(server);
    try {
      const pinned = { certFingerprint: fixture.fingerprint, certPem: fixture.pem };
      const response = await pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, pinned, {});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("transfer-encoding"), "chunked");
      assert.deepEqual(JSON.parse(await response.text()), { object: "list", data: [{ id: "omlx-qwen38-flash-oq4e" }] });

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => pinnedHttpsFetch(`https://127.0.0.1:${port}/v1/models`, pinned, { signal: controller.signal }),
        (error) => error?.code === "provider-timeout",
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
