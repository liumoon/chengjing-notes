"use strict";
// 自簽憑證信任：只在「使用者明確核對並核准過的 SHA-256 指紋」與「該 provider 自己的主機」同時成立時放行。
// 絕不做全域 TLS 關閉。
const https = require("node:https");
const tls = require("node:tls");
const crypto = require("node:crypto");

const FINGERPRINT_LENGTH = 64;
const PEER_READ_TIMEOUT_MS = 8_000;
const MAX_PINNED_RESPONSE_BYTES = 12_000_000;

function normalizeCertFingerprint(value) {
  const hex = String(value == null ? "" : value).toUpperCase().replace(/[^0-9A-F]/g, "");
  return hex.length === FINGERPRINT_LENGTH ? hex : "";
}

function formatCertFingerprint(value) {
  const hex = normalizeCertFingerprint(value);
  return hex ? hex.match(/.{2}/g).join(":") : "";
}

function hostnameOf(rawUrl) {
  try { return new URL(String(rawUrl || "").trim()).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
  catch { return ""; }
}

const TLS_ERROR_PATTERNS = [
  /ERR_CERT_/i,
  /ERR_SSL/i,
  /self[-_ ]?signed/i,
  /self[-_ ]?signed certificate/i,
  /unable to get local issuer certificate/i,
  /unable to verify the first certificate/i,
  /certificate has expired/i,
  /certificate revoked/i,
  /unknown ca/i,
  /unknown_authority/i,
  /no certificate returned/i,
  /handshake failure/i,
  /wrong version number/i,
  /EPROTO/i,
  /SSLV3_ALERT/i,
  /CERTIFICATE_VERIFY_FAILED/i,
];

function isTlsFailure(value) {
  const text = String(value == null ? "" : value);
  return TLS_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

// 只有同時滿足：https + 主機完全相符 + 該 provider 已存指紋 + 指紋完全相符，才允許略過 TLS 錯誤。
function pinnedFingerprintForTarget(profiles, rawUrl) {
  const host = hostnameOf(rawUrl);
  if (!host) return null;
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile || hostnameOf(profile.baseUrl) !== host) continue;
    const fingerprint = normalizeCertFingerprint(profile.certFingerprint);
    if (fingerprint) return { id: String(profile.id || ""), host, fingerprint };
  }
  return null;
}

// 繼承信任要比對 origin（協定＋主機＋埠）；任一改變都視為另一台服務，舊信任一律不沿用。
function originOf(rawUrl) {
  try {
    const url = new URL(String(rawUrl || "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
  } catch { return ""; }
}

function isHttpsTarget(rawUrl) {
  try { return new URL(String(rawUrl || "").trim()).protocol === "https:"; } catch { return false; }
}

function hasPinnedHost(profiles, rawUrl) {
  const host = hostnameOf(rawUrl);
  if (!host) return false;
  return (Array.isArray(profiles) ? profiles : []).some((profile) => Boolean(profile?.certFingerprint) && hostnameOf(profile?.baseUrl) === host);
}

function isCertificateAllowed(profiles, rawUrl, rawFingerprint) {
  const pinned = pinnedFingerprintForTarget(profiles, rawUrl);
  if (!pinned) return false;
  const presented = normalizeCertFingerprint(rawFingerprint);
  return Boolean(presented) && presented === pinned.fingerprint;
}

// Electron 的 certificate.data 是 PEM 文字；指紋必須算 DER，先拆掉 PEM 護欄再雜湊。
function fingerprintFromCertificate(certificate) {
  const raw = certificate?.data ?? certificate;
  if (!raw) return "";
  const buffer = Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw) : null;
  const text = buffer ? buffer.toString("utf8") : String(raw);
  if (buffer && !text.includes("-----BEGIN")) return normalizeCertFingerprint(crypto.createHash("sha256").update(buffer).digest("hex"));
  if (text.includes("-----BEGIN")) {
    const body = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    try { return normalizeCertFingerprint(crypto.createHash("sha256").update(Buffer.from(body, "base64")).digest("hex")); }
    catch { return ""; }
  }
  return normalizeCertFingerprint(text);
}

// 只保留 PEM 本體並限制長度，避免設定檔被塞入任意內容。
function normalizeCertPem(value) {
  const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  if (!text.startsWith("-----BEGIN CERTIFICATE-----") || !text.endsWith("-----END CERTIFICATE-----")) return "";
  return text.length > 8_000 ? "" : `${text}\n`;
}

function pemFromDer(der) {
  const body = Buffer.from(der).toString("base64").match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

function isIpv4Literal(host) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(host || ""));
}

// 以「使用者核准過的這張憑證」作為唯一信任锚走 Node TLS：
// 仍做完整的簽章與有效期限驗證，只是信任锚由使用者指定，不碰系統鑰匙串也不全域放行。
function pinnedHttpsFetch(rawUrl, pinned, options = {}) {
  const fingerprint = normalizeCertFingerprint(pinned?.certFingerprint);
  const authority = String(pinned?.certPem || "").trim();
  if (!fingerprint || !authority) return Promise.reject(new Error("cert-pin-missing"));
  let target;
  try { target = new URL(String(rawUrl || "").trim()); }
  catch { return Promise.reject(new Error("cert-target-invalid")); }
  if (target.protocol !== "https:") return Promise.reject(new Error("cert-target-invalid"));
  if (target.username || target.password) return Promise.reject(new Error("cert-target-invalid"));
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 20_000, 1_000), 200_000);
  const payload = typeof options.body === "string" ? Buffer.from(options.body, "utf8") : null;
  return new Promise((resolve, reject) => {
    // 一定要用專屬且不保活的 agent：共用連線池會讓指紋檢查只在第一次握手生效，
    // 之後的请求直接沿用舊 socket，等於繞過憑證驗證。
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1, noDelay: true });
    const request = https.request({
      agent,
      host: hostname,
      port: Number(target.port) || 443,
      path: `${target.pathname}${target.search}` || "/",
      method: String(options.method || "GET").toUpperCase(),
      headers: options.headers || {},
      ca: [authority],
      rejectUnauthorized: true,
      servername: isIpv4Literal(hostname) ? undefined : hostname,
      // 指紋已由使用者核對，這裡只擋指紋不符，不再要求 SAN 與 IP 相符。
      checkServerIdentity: (_host, cert) => {
        const presented = fingerprintFromCertificate({ data: cert?.raw });
        return presented && presented === fingerprint ? undefined : new Error("net::ERR_CERT_AUTHORITY_INVALID");
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PINNED_RESPONSE_BYTES) { request.destroy(new Error("provider-response-too-large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers || {})) {
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else if (value != null) headers.append(key, String(value));
        }
        resolve({ ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300, status: response.statusCode || 0, statusText: response.statusMessage || "", headers, text: async () => text });
      });
    });
    request.on("timeout", () => request.destroy(new Error("provider-timeout")));
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) request.destroy(new Error("provider-timeout"));
      else signal.addEventListener("abort", () => request.destroy(new Error("provider-timeout")), { once: true });
    }
    request.on("error", (error) => reject(error?.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || /ERR_CERT|self[-_ ]?signed/i.test(String(error?.message)) ? new Error("net::ERR_CERT_AUTHORITY_INVALID") : error));
    if (payload) request.write(payload);
    request.end();
  });
}

// fetch/undici 會把 TLS 細節包在 cause 裡；攤平整條錯誤鏈才能判別與顯示。
function describeError(error, maxDepth = 4) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    const text = current instanceof Error ? current.message : String(current);
    if (text && !parts.includes(text)) parts.push(text);
    current = current.cause;
  }
  return parts.join(": ").slice(0, 320);
}

// 只讀取對方憑證內容給使用者核對，不會傳送任何資料或金鑰。
function readPeerCertificate(rawUrl, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || PEER_READ_TIMEOUT_MS, 1_000), 20_000);
  let target;
  try { target = new URL(String(rawUrl || "").trim()); }
  catch { return Promise.reject(new Error("cert-target-invalid")); }
  if (target.protocol !== "https:") return Promise.reject(new Error("cert-target-invalid"));
  if (target.username || target.password) return Promise.reject(new Error("cert-target-invalid"));
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port) || 443;
  if (!hostname) return Promise.reject(new Error("cert-target-invalid"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect({ host: hostname, port, servername: /^[0-9.]+$|^[0-9a-f:]+$/i.test(hostname) ? undefined : hostname, rejectUnauthorized: false, timeout: timeoutMs });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once("secureConnect", () => {
      try {
        const cert = socket.getPeerX509Certificate ? socket.getPeerX509Certificate() : null;
        const raw = cert?.raw ? Buffer.from(cert.raw) : null;
        const fingerprint = normalizeCertFingerprint(raw
          ? crypto.createHash("sha256").update(raw).digest("hex")
          : String(cert?.fingerprint256 || cert?.fingerprint || ""));
        if (!fingerprint) return finish(new Error("cert-unavailable"));
        finish(null, {
          fingerprint,
          certPem: raw ? pemFromDer(raw) : "",
          hostname,
          port,
          subject: String(cert?.subject || "").slice(0, 240),
          issuer: String(cert?.issuer || "").slice(0, 240),
          validFrom: String(cert?.validFrom || "").slice(0, 64),
          validTo: String(cert?.validTo || "").slice(0, 64),
          authorized: Boolean(socket.authorized),
          authorizationError: socket.authorized ? "" : String(socket.authorizationError || "").slice(0, 240),
        });
      } catch (error) { finish(error); }
    });
    socket.once("timeout", () => finish(new Error("cert-timeout")));
    socket.once("error", (error) => finish(error));
  });
}

module.exports = {
  FINGERPRINT_LENGTH,
  PEER_READ_TIMEOUT_MS,
  formatCertFingerprint,
  hostnameOf,
  isHttpsTarget,
  isIpv4Literal,
  hasPinnedHost,
  isCertificateAllowed,
  describeError,
  fingerprintFromCertificate,
  isTlsFailure,
  normalizeCertFingerprint,
  normalizeCertPem,
  originOf,
  pemFromDer,
  pinnedHttpsFetch,
  pinnedFingerprintForTarget,
  readPeerCertificate,
};
