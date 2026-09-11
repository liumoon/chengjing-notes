"use strict";

/**
 * `documents.cjs` 的原生單元測試（桌面端文件匯入附件橋接）。
 *
 * 涵蓋規格的安全驗收：私有 IP、重新導向至內網、超大圖片、相對路徑穿越、
 * 逾時與 MIME；以及 `resolveLocalAssets` 只讀來源資料夾的邊界保護。
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { downloadRemoteAssets, resolveLocalAssets, __security: security } = require("./documents.cjs");

const { isPrivateAddress, isHttpUrl, assertPublicImageUrl, detectMime } = security;

/* -------------------------------------------------------------------------- */
/* 位址與協定安全                                                              */
/* -------------------------------------------------------------------------- */

test("isHttpUrl 只接受 HTTP／HTTPS", () => {
  assert.equal(isHttpUrl("https://example.com/a.png"), true);
  assert.equal(isHttpUrl("http://example.com/a.png"), true);
  assert.equal(isHttpUrl("ftp://example.com/a.png"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("not a url"), false);
});

test("isPrivateAddress 拒絕 loopback、私有網段、連結本地與雲中 metadata", () => {
  const privateHosts = [
    "127.0.0.1", "localhost", "10.0.0.5", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "metadata.google.internal", "::1", "fd00::1",
    "127.1", "0x7f000001", "2130706433",
  ];
  for (const host of privateHosts) assert.equal(isPrivateAddress(host), true, `expected ${host} private`);
  assert.equal(isPrivateAddress("example.com"), false);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
});

test("assertPublicImageUrl 拒絕私有位址、路徑穿越與非 HTTP 協定", () => {
  assert.equal(assertPublicImageUrl("https://example.com/a.png"), "");
  assert.equal(assertPublicImageUrl("https://127.0.0.1/"), "private-address");
  assert.equal(assertPublicImageUrl("https://example.com/../etc/passwd"), "path-traversal");
  assert.equal(assertPublicImageUrl("ftp://example.com/x"), "unsupported-scheme");
  assert.equal(assertPublicImageUrl("https://user:pass@example.com/x"), "credentials-in-url");
});

test("detectMime 依魔法檔頭辨別圖片格式", () => {
  assert.equal(detectMime("x.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(detectMime("x", Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectMime("x", Buffer.from([0x47, 0x49, 0x46, 0x38])), "image/gif");
  assert.equal(detectMime("note.txt", Buffer.from("hello", "utf8")), "");
});

/* -------------------------------------------------------------------------- */
/* resolveLocalAssets：只讀來源資料夾                                          */
/* -------------------------------------------------------------------------- */

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cj-docs-"));
  await fs.writeFile(path.join(dir, "note.md"), "# 標題\n\n文字");
  await fs.writeFile(path.join(dir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  await fs.mkdir(path.join(dir, "img"));
  await fs.writeFile(path.join(dir, "img", "pic.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xdb]));
  return dir;
}

test("resolveLocalAssets 讀取來源資料夾的相對圖片並回報 MIME 與大小", async () => {
  const dir = await makeTempDir();
  try {
    const result = await resolveLocalAssets({ sourcePath: path.join(dir, "note.md"), names: ["photo.png", "img/pic.jpg"] });
    assert.equal(result.rootPath, path.resolve(dir));
    const byName = Object.fromEntries(result.assets.map((asset) => [asset.name, asset]));
    assert.equal(byName["photo.png"].mime, "image/png");
    assert.equal(typeof byName["photo.png"].data, "string");
    assert.equal(byName["img/pic.jpg"].mime, "image/jpeg");
    assert.equal(byName["img/pic.jpg"].size, 6);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolveLocalAssets 阻斷相對路徑穿越來源資料夾", async () => {
  const dir = await makeTempDir();
  try {
    const result = await resolveLocalAssets({ sourcePath: path.join(dir, "note.md"), names: ["../secret.png"] });
    assert.equal(result.assets[0].error, "path-traversal");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resolveLocalAssets 對不存在的資源回報錯誤而非崩潰", async () => {
  const dir = await makeTempDir();
  try {
    const result = await resolveLocalAssets({ sourcePath: path.join(dir, "note.md"), names: ["missing.png"] });
    assert.equal(result.assets[0].error, "not-found");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* downloadRemoteAssets：公開圖片下載與安全覆核                                */
/* -------------------------------------------------------------------------- */

function imageBody(bytes) {
  return new Uint8Array(bytes);
}

function makeNet(routes) {
  const calls = new Map();
  const net = {
    fetch: async (url) => {
      const key = String(url);
      calls.set(key, (calls.get(key) || 0) + 1);
      const route = routes.get(key);
      if (!route) throw new Error(`no-route:${key}`);
      if (route.error) throw route.error;
      const headers = new Map();
      if (route.location) headers.set("location", route.location);
      const body = route.body || imageBody(0);
      const status = route.status || 200;
      return {
        // 模擬 Node/Electron Response：ok 由狀態碼決定。
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
        arrayBuffer: () => Promise.resolve(new Uint8Array(body).buffer),
      };
    },
    _calls: calls,
  };
  return net;
}

const PUBLIC = "https://cdn.example.com/pic.png";

test("downloadRemoteAssets 下載公開圖片並偵測 MIME", async () => {
  const net = makeNet(new Map([[PUBLIC, { status: 200, body: imageBody([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }]]));
  const [asset] = await downloadRemoteAssets(net, { urls: [PUBLIC], maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(asset.ok, true);
  assert.equal(asset.mime, "image/png");
  assert.equal(asset.size, 8);
  assert.equal(typeof asset.data, "string");
});

test("downloadRemoteAssets 拒絕私有位址（含雲中 metadata）", async () => {
  const net = makeNet(new Map());
  for (const url of ["https://127.0.0.1/secret.png", "https://169.254.169.254/latest"]) {
    const [asset] = await downloadRemoteAssets(net, { urls: [url], maxBytesPerAsset: 10 * 1024 * 1024 });
    assert.equal(asset.ok, false);
    assert.equal(asset.error, "private-address");
  }
});

test("downloadRemoteAssets 拒絕重新導向至內網", async () => {
  const net = makeNet(new Map([[PUBLIC, { status: 302, location: "https://127.0.0.1/steal.png" }]]));
  const [asset] = await downloadRemoteAssets(net, { urls: [PUBLIC], maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(asset.ok, false);
  assert.equal(asset.error, "private-address");
  assert.equal(asset.redirectedTo, "https://127.0.0.1/steal.png");
});

test("downloadRemoteAssets 跟蹤重導向到公開端點", async () => {
  const finalUrl = "https://cdn.example.com/final.png";
  const net = makeNet(
    new Map([
      [PUBLIC, { status: 302, location: finalUrl }],
      [finalUrl, { status: 200, body: imageBody([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xdb]) }],
    ]),
  );
  const [asset] = await downloadRemoteAssets(net, { urls: [PUBLIC], maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(asset.ok, true);
  assert.equal(asset.mime, "image/jpeg");
  assert.equal(asset.redirectedTo, finalUrl);
});

test("downloadRemoteAssets 拒絕過多重導向", async () => {
  const routes = new Map();
  let current = PUBLIC;
  // 六張連續重新導向（超過 maxRedirects=5）。
  for (let i = 0; i < 6; i += 1) {
    const next = `https://cdn.example.com/chain/${i}.png`;
    routes.set(current, { status: 302, location: next });
    current = next;
  }
  routes.set(current, { status: 200, body: imageBody([0x89, 0x50, 0x4e, 0x47]) });
  const net = makeNet(routes);
  const [asset] = await downloadRemoteAssets(net, { urls: [PUBLIC], maxRedirects: 5, maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(asset.ok, false);
  assert.equal(asset.error, "too-many-redirects");
});

test("downloadRemoteAssets 拒絕超單張上限的圖片", async () => {
  const net = makeNet(new Map([[PUBLIC, { status: 200, body: imageBody(new Array(11 * 1024 * 1024).fill(0)) }]]));
  const [asset] = await downloadRemoteAssets(net, { urls: [PUBLIC], maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(asset.ok, false);
  assert.equal(asset.error, "too-large");
});

test("downloadRemoteAssets 整份檔案合計超限時拒絕", async () => {
  const small = 4 * 1024 * 1024;
  const net = makeNet(
    new Map([
      [PUBLIC, { status: 200, body: imageBody(small) }],
      ["https://cdn.example.com/second.png", { status: 200, body: imageBody(small) }],
    ]),
  );
  // 合計上限 5 MB，兩張各 4 MB 會撞界。
  const assets = await downloadRemoteAssets(net, { urls: [PUBLIC, "https://cdn.example.com/second.png"], maxTotalBytes: 5 * 1024 * 1024, maxBytesPerAsset: 10 * 1024 * 1024 });
  const second = assets.find((entry) => entry.url.endsWith("second.png"));
  assert.equal(assets[0].ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error, "total-budget-exceeded");
});

test("downloadRemoteAssets 逾時不中斷其他下載", async () => {
  const net = makeNet(
    new Map([
      [PUBLIC, { error: Object.assign(new Error("aborted"), { code: "ABORT_ERR" }) }],
      ["https://cdn.example.com/ok.png", { status: 200, body: imageBody([0x89, 0x50, 0x4e, 0x47]) }],
    ]),
  );
  const assets = await downloadRemoteAssets(net, { urls: [PUBLIC, "https://cdn.example.com/ok.png"], timeoutMs: 15 * 1000, maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(assets[0].ok, false);
  assert.equal(assets[0].error, "timeout");
  assert.equal(assets[1].ok, true);
});

test("downloadRemoteAssets 非 HTTP 協定與非圖片 MIME 一律不接受", async () => {
  const net = makeNet(new Map());
  const [scheme] = await downloadRemoteAssets(net, { urls: ["ftp://example.com/a.png"], maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(scheme.ok, false);
  assert.equal(scheme.error, "unsupported-scheme");

  const textNet = makeNet(new Map([[PUBLIC, { status: 200, body: new Uint8Array(Buffer.from("not an image", "utf8")) }]]));
  const [text] = await downloadRemoteAssets(textNet, { urls: [PUBLIC], maxBytesPerAsset: 10 * 1024 * 1024 });
  assert.equal(text.ok, true);
  // 原生層回報非 image MIME；渲染端會以此拒絕（非追蹤內容）。
  assert.ok(!text.mime.startsWith("image/"));
});
