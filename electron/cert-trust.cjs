"use strict";
// 自簽憑證信任：只在「使用者明確核對並核准過的 SHA-256 指紋」與「該 provider 自己的主機」同時成立時放行。
// 絕不做全域 TLS 關閉。
const tls = require("node:tls");
const crypto = require("node:crypto");

const FINGERPRINT_LENGTH = 64;
const PEER_READ_TIMEOUT_MS = 8_000;
const MAX_PINNED_RESPONSE_BYTES = 12_000_000;
const MAX_PINNED_HEADER_BYTES = 256_000;

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
  /cert-pin-/i,
  /cert-expired/i,
  /cert-invalid/i,
  /cert-target-invalid/i,
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
  const targetOrigin = originOf(rawUrl);
  if (!targetOrigin || !isHttpsTarget(rawUrl)) return null;
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile || originOf(profile.baseUrl) !== targetOrigin) continue;
    const fingerprint = normalizeCertFingerprint(profile.certFingerprint);
    if (fingerprint) return { id: String(profile.id || ""), host: hostnameOf(rawUrl), origin: targetOrigin, fingerprint };
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
  const targetOrigin = originOf(rawUrl);
  if (!targetOrigin || !isHttpsTarget(rawUrl)) return false;
  return (Array.isArray(profiles) ? profiles : []).some((profile) => Boolean(profile?.certFingerprint) && originOf(profile?.baseUrl) === targetOrigin);
}

function isCertificateAllowed(profiles, rawUrl, rawFingerprint) {
  const pinned = pinnedFingerprintForTarget(profiles, rawUrl);
  if (!isHttpsTarget(rawUrl)) return false;
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

function trustError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function certificateDetails(raw, socket) {
  const der = raw ? Buffer.from(raw) : null;
  if (!der?.length) throw trustError("cert-invalid");
  try {
    const certificate = new crypto.X509Certificate(der);
    const validFrom = String(certificate.validFrom || "").slice(0, 64);
    const validTo = String(certificate.validTo || "").slice(0, 64);
    const validFromMs = Date.parse(validFrom);
    const validToMs = Date.parse(validTo);
    const fingerprint = normalizeCertFingerprint(certificate.fingerprint256)
      || normalizeCertFingerprint(crypto.createHash("sha256").update(der).digest("hex"));
    if (!fingerprint || !Number.isFinite(validFromMs) || !Number.isFinite(validToMs) || validFromMs > validToMs) {
      throw trustError("cert-invalid");
    }
    return {
      raw: der,
      certPem: pemFromDer(der),
      fingerprint,
      subject: String(certificate.subject || "").slice(0, 240),
      issuer: String(certificate.issuer || "").slice(0, 240),
      validFrom,
      validTo,
      validFromMs,
      validToMs,
      authorized: Boolean(socket?.authorized),
      authorizationError: socket?.authorized ? "" : String(socket?.authorizationError || "").slice(0, 240),
    };
  } catch (error) {
    if (error?.code === "cert-invalid") throw error;
    throw trustError("cert-invalid", { cause: error });
  }
}

function peerRawCertificate(socket) {
  const x509 = socket?.getPeerX509Certificate?.();
  if (x509?.raw) return Buffer.from(x509.raw);
  const peer = socket?.getPeerCertificate?.(true);
  return peer?.raw ? Buffer.from(peer.raw) : null;
}

function headerPairs(rawHeaders) {
  const result = [];
  for (const [rawName, rawValue] of Object.entries(rawHeaders || {})) {
    const name = String(rawName);
    const value = Array.isArray(rawValue) ? rawValue.map(String).join(", ") : String(rawValue ?? "");
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n]/.test(value)) {
      throw trustError("cert-target-invalid");
    }
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length" || lower === "transfer-encoding") continue;
    result.push([name, value]);
  }
  return result;
}

function parseResponseHeaders(buffer) {
  const marker = buffer.indexOf("\r\n\r\n");
  if (marker < 0) return null;
  if (marker > MAX_PINNED_HEADER_BYTES) throw trustError("provider-response-too-large");
  const text = buffer.subarray(0, marker).toString("latin1");
  const lines = text.split("\r\n");
  const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/.exec(lines.shift() || "");
  if (!status) throw trustError("provider-response-invalid");
  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw trustError("provider-response-invalid");
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!name || /[\r\n]/.test(value)) throw trustError("provider-response-invalid");
    headers.append(name, value);
  }
  const contentLengthValue = headers.get("content-length");
  const contentLength = contentLengthValue == null ? null : Number(contentLengthValue);
  if (contentLength != null && (!Number.isSafeInteger(contentLength) || contentLength < 0)) throw trustError("provider-response-invalid");
  if (contentLength != null && contentLength > MAX_PINNED_RESPONSE_BYTES) throw trustError("provider-response-too-large");
  const transferEncoding = String(headers.get("transfer-encoding") || "").toLowerCase();
  return {
    consumed: marker + 4,
    status: Number(status[1]),
    statusText: status[2] || "",
    headers,
    contentLength,
    chunked: transferEncoding.split(",").map((item) => item.trim()).includes("chunked"),
  };
}

function buildPinnedResponse(meta, body) {
  const text = Buffer.concat(body).toString("utf8");
  return {
    ok: meta.status >= 200 && meta.status < 300,
    status: meta.status,
    statusText: meta.statusText,
    headers: meta.headers,
    text: async () => text,
  };
}

// 以「使用者核准過的指紋」作為唯一信任錨走獨立 Node TLS 連線。
// TLS handshake 不依賴系統 CA 鏈，但仍在送出 HTTP 請求前檢查實際 DER 憑證與有效期限。
function pinnedHttpsFetch(rawUrl, pinned, options = {}) {
  const fingerprint = normalizeCertFingerprint(pinned?.certFingerprint);
  const authority = normalizeCertPem(pinned?.certPem);
  if (!fingerprint || !authority) return Promise.reject(trustError("cert-pin-missing"));
  if (fingerprintFromCertificate({ data: authority }) !== fingerprint) return Promise.reject(trustError("cert-invalid"));
  let target;
  try { target = new URL(String(rawUrl || "").trim()); }
  catch { return Promise.reject(trustError("cert-target-invalid")); }
  if (target.protocol !== "https:") return Promise.reject(trustError("cert-target-invalid"));
  if (target.username || target.password || !target.hostname) return Promise.reject(trustError("cert-target-invalid"));
  if (pinned?.origin && originOf(target.href) !== originOf(pinned.origin)) return Promise.reject(trustError("cert-target-invalid"));
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 20_000, 1_000), 200_000);
  const payload = typeof options.body === "string"
    ? Buffer.from(options.body, "utf8")
    : Buffer.isBuffer(options.body) || options.body instanceof Uint8Array
      ? Buffer.from(options.body)
      : null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let secure = false;
    let responseMeta = null;
    let pending = Buffer.alloc(0);
    let bodyChunks = [];
    let bodyBytes = 0;
    let chunkRemaining = null;
    let chunkDone = false;
    let abortListener;
    const socket = tls.connect({
      host: hostname,
      port: Number(target.port) || 443,
      servername: isIpv4Literal(hostname) ? undefined : hostname,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const fail = (error) => finish(error instanceof Error ? error : trustError(String(error || "provider-unavailable")));
    const appendBody = (chunk) => {
      if (!chunk?.length) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_PINNED_RESPONSE_BYTES) return fail(trustError("provider-response-too-large"));
      bodyChunks.push(Buffer.from(chunk));
    };
    const consumeChunked = () => {
      while (!chunkDone) {
        if (chunkRemaining == null) {
          const lineEnd = pending.indexOf("\r\n");
          if (lineEnd < 0) return;
          const line = pending.subarray(0, lineEnd).toString("ascii").split(";", 1)[0].trim();
          const size = Number.parseInt(line, 16);
          if (!Number.isFinite(size) || size < 0) return fail(trustError("provider-response-invalid"));
          pending = pending.subarray(lineEnd + 2);
          if (size === 0) {
            chunkDone = true;
            if (pending.length >= 2 && pending.subarray(0, 2).equals(Buffer.from("\r\n"))) {
              pending = pending.subarray(2);
              return finish(null, buildPinnedResponse(responseMeta, bodyChunks));
            }
            const trailersEnd = pending.indexOf("\r\n\r\n");
            if (trailersEnd >= 0) {
              pending = pending.subarray(trailersEnd + 4);
              return finish(null, buildPinnedResponse(responseMeta, bodyChunks));
            }
            return;
          }
          chunkRemaining = size;
        }
        if (pending.length < chunkRemaining + 2) return;
        appendBody(pending.subarray(0, chunkRemaining));
        if (settled) return;
        if (!pending.subarray(chunkRemaining, chunkRemaining + 2).equals(Buffer.from("\r\n"))) return fail(trustError("provider-response-invalid"));
        pending = pending.subarray(chunkRemaining + 2);
        chunkRemaining = null;
      }
    };
    const consumeResponse = () => {
      if (!responseMeta) {
        const parsed = parseResponseHeaders(pending);
        if (!parsed) {
          if (pending.length > MAX_PINNED_HEADER_BYTES) fail(trustError("provider-response-too-large"));
          return;
        }
        responseMeta = parsed;
        pending = pending.subarray(parsed.consumed);
        if ([204, 304].includes(parsed.status) || (parsed.contentLength === 0 && !parsed.chunked)) {
          return finish(null, buildPinnedResponse(responseMeta, bodyChunks));
        }
      }
      if (responseMeta.chunked) {
        consumeChunked();
        return;
      }
      if (responseMeta.contentLength != null) {
        const remaining = responseMeta.contentLength - bodyBytes;
        if (remaining > 0) appendBody(pending.subarray(0, remaining));
        pending = pending.subarray(Math.min(remaining, pending.length));
        if (!settled && bodyBytes >= responseMeta.contentLength) finish(null, buildPinnedResponse(responseMeta, bodyChunks));
        return;
      }
      appendBody(pending);
      pending = Buffer.alloc(0);
    };
    socket.setTimeout(timeoutMs, () => fail(trustError("provider-timeout")));
    socket.once("secureConnect", () => {
      secure = true;
      try {
        const peer = certificateDetails(peerRawCertificate(socket), socket);
        const now = Date.now();
        if (peer.fingerprint !== fingerprint) return fail(trustError("cert-pin-mismatch", { presentedFingerprint: peer.fingerprint, certValidFrom: peer.validFrom, certValidTo: peer.validTo, authorizationError: peer.authorizationError }));
        if (now < peer.validFromMs || now > peer.validToMs) return fail(trustError("cert-expired", { presentedFingerprint: peer.fingerprint, certValidFrom: peer.validFrom, certValidTo: peer.validTo, authorizationError: peer.authorizationError }));
        const method = String(options.method || "GET").toUpperCase();
        const requestPath = `${target.pathname || "/"}${target.search || ""}`;
        const lines = [`${method} ${requestPath} HTTP/1.1`, `Host: ${target.host}`, "Connection: close"];
        for (const [name, value] of headerPairs(options.headers)) lines.push(`${name}: ${value}`);
        if (payload) lines.push(`Content-Length: ${payload.length}`);
        lines.push("", "");
        socket.write(lines.join("\r\n"));
        if (payload?.length) socket.write(payload);
      } catch (error) { fail(error); }
    });
    socket.on("data", (chunk) => {
      if (!secure || settled) return;
      pending = pending.length ? Buffer.concat([pending, Buffer.from(chunk)]) : Buffer.from(chunk);
      consumeResponse();
    });
    socket.once("end", () => {
      if (settled) return;
      if (responseMeta && responseMeta.contentLength == null && !responseMeta.chunked) {
        finish(null, buildPinnedResponse(responseMeta, bodyChunks));
      } else {
        fail(trustError("provider-response-invalid"));
      }
    });
    const signal = options.signal;
    if (signal) {
      abortListener = () => fail(trustError("provider-timeout"));
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
    socket.once("error", (error) => {
      if (settled) return;
      if (isTlsFailure(error?.code || error?.message)) fail(trustError("cert-invalid", { cause: error }));
      else fail(error);
    });
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
        const peer = certificateDetails(peerRawCertificate(socket), socket);
        finish(null, {
          fingerprint: peer.fingerprint,
          certPem: peer.certPem,
          hostname,
          port,
          subject: peer.subject,
          issuer: peer.issuer,
          validFrom: peer.validFrom,
          validTo: peer.validTo,
          authorized: peer.authorized,
          authorizationError: peer.authorizationError,
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
