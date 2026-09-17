const { isTlsFailure } = require("./cert-trust.cjs");

const messages = {
  "zh-TW": { auth: "AI Provider 拒絕授權，請確認金鑰與使用權限。", missing: "AI Provider 找不到這個模型或 API 路徑。", rate: "AI Provider 已達額度或請求速率限制，請稍後再試。", server: "AI Provider 服務發生錯誤，請稍後再試。", rejected: "AI Provider 已收到請求，但不接受其中的設定。", certificate: "伺服器憑證不受信任（可能是自簽憑證）。請核對憑證指紋後手動信任，或改用受信任的憑證。", certificateChanged: "伺服器憑證已更換，與已儲存的指紋不同。澄境不會自動更新信任。", certificateExpired: "伺服器憑證已過期或尚未生效，請更換有效憑證。", certificateInvalid: "伺服器憑證格式或 TLS 驗證失敗，請檢查憑證與系統時間。", targetInvalid: "AI Provider 的 HTTPS 位址不合法，請確認通訊協定、主機與連接埠。", pinMissing: "尚未完整保存憑證指紋與 PEM，請重新測試並核對伺服器憑證。", timeout: "AI Provider 連線逾時，請檢查服務與網路後再試。" },
  "zh-CN": { auth: "AI Provider 拒绝授权，请检查密钥与权限。", missing: "AI Provider 找不到该模型或 API 路径。", rate: "AI Provider 已达额度或请求频率限制，请稍后重试。", server: "AI Provider 服务发生错误，请稍后重试。", rejected: "AI Provider 已收到请求，但不接受其中的设置。", certificate: "服务器证书不受信任（可能是自签名证书）。请核对证书指纹后手动信任，或改用受信任的证书。", certificateChanged: "服务器证书已更换，与已保存的指纹不同。澄境不会自动更新信任。", certificateExpired: "服务器证书已过期或尚未生效，请更换有效证书。", certificateInvalid: "服务器证书格式或 TLS 验证失败，请检查证书和系统时间。", targetInvalid: "AI Provider 的 HTTPS 地址无效，请检查协议、主机和端口。", pinMissing: "尚未完整保存证书指纹和 PEM，请重新测试并核对服务器证书。", timeout: "AI Provider 连接超时，请检查服务和网络后重试。" },
  en: { auth: "The AI provider denied authorization. Check your key and permissions.", missing: "The AI provider could not find this model or API path.", rate: "The AI provider reached a quota or rate limit. Try again later.", server: "The AI provider encountered a server error. Try again later.", rejected: "The AI provider received the request but rejected its settings.", certificate: "The server certificate is not trusted (it may be self-signed). Verify the fingerprint and trust it explicitly, or use a trusted certificate.", certificateChanged: "The server certificate changed and no longer matches the saved fingerprint. ChengJing will not update trust automatically.", certificateExpired: "The server certificate is expired or not yet valid. Replace it with a valid certificate.", certificateInvalid: "The server certificate or TLS validation failed. Check the certificate and system clock.", targetInvalid: "The AI provider HTTPS target is invalid. Check the protocol, host, and port.", pinMissing: "The certificate fingerprint and PEM are not stored as a complete pair. Test again and verify the server certificate.", timeout: "The AI provider connection timed out. Check the service and network, then try again." },
  ja: { auth: "AI Providerが認証を拒否しました。キーと権限を確認してください。", missing: "モデルまたはAPIパスが見つかりません。", rate: "AI Providerの利用枠または回数制限に達しました。後でもう一度お試しください。", server: "AI Providerでサーバーエラーが発生しました。", rejected: "AI Providerがリクエストの設定を受け付けませんでした。", certificate: "サーバー証明書が信頼できません（自己署名の可能性があります）。指紋を確認して明示的に信頼するか、信頼できる証明書をご利用ください。", certificateChanged: "サーバー証明書が変更され、保存済みの指紋と一致しません。自動更新はしません。", certificateExpired: "サーバー証明書の期限が切れているか、まだ有効ではありません。有効な証明書に交換してください。", certificateInvalid: "サーバー証明書またはTLS検証に失敗しました。証明書とシステム時刻を確認してください。", targetInvalid: "AI ProviderのHTTPSアドレスが無効です。プロトコル、ホスト、ポートを確認してください。", pinMissing: "証明書の指紋とPEMが完全な組み合わせで保存されていません。再テストして証明書を確認してください。", timeout: "AI Providerへの接続がタイムアウトしました。サービスとネットワークを確認してください。" },
  ko: { auth: "AI Provider가 인증을 거부했습니다. 키와 권한을 확인하세요.", missing: "AI Provider가 모델 또는 API 경로를 찾지 못했습니다.", rate: "AI Provider의 할당량 또는 요청 제한에 도달했습니다. 나중에 다시 시도하세요.", server: "AI Provider에 서버 오류가 발생했습니다.", rejected: "AI Provider가 요청을 받았지만 설정을 거부했습니다.", certificate: "서버 인증서가 신뢰되지 않습니다(자체 서명일 수 있습니다). 지문을 확인한 뒤 명시적으로 신뢰하거나 신뢰되는 인증서를 사용하세요.", certificateChanged: "서버 인증서가 변경되어 저장된 지문과 일치하지 않습니다. 자동으로 신뢰를 갱신하지 않습니다.", certificateExpired: "서버 인증서가 만료되었거나 아직 유효하지 않습니다. 유효한 인증서로 교체하세요.", certificateInvalid: "서버 인증서 또는 TLS 검증에 실패했습니다. 인증서와 시스템 시간을 확인하세요.", targetInvalid: "AI Provider HTTPS 주소가 올바르지 않습니다. 프로토콜, 호스트 및 포트를 확인하세요.", pinMissing: "인증서 지문과 PEM이 완전한 쌍으로 저장되지 않았습니다. 다시 테스트하고 서버 인증서를 확인하세요.", timeout: "AI Provider 연결 시간이 초과되었습니다. 서비스와 네트워크를 확인한 뒤 다시 시도하세요." },
};
function providerHttpError(code, language) {
  const match = /^provider-http-(\d+)(?::(.*))?$/s.exec(code);
  if (!match) return null;
  const status = Number(match[1]);
  const copy = messages[language] || messages.en;
  const reason = [401, 403].includes(status) ? copy.auth : status === 404 ? copy.missing : status === 429 ? copy.rate : status >= 500 ? copy.server : copy.rejected;
  return match[2]?.trim() ? `${reason} (${match[2].trim()})` : reason;
}
function providerDiagnosticError(code, language) {
  const copy = messages[language] || messages.en;
  if (code === "provider-timeout") return copy.timeout;
  if (code === "cert-pin-mismatch") return copy.certificateChanged;
  if (code === "cert-pin-missing") return copy.pinMissing;
  if (code === "cert-expired") return copy.certificateExpired;
  if (code === "cert-invalid") return copy.certificateInvalid;
  if (code === "cert-target-invalid") return copy.targetInvalid;
  if (code === "provider-model-not-found") return copy.missing;
  if (code === "provider-model-required") return copy.missing;
  if (code === "provider-base-url-invalid" || code === "provider-insecure-remote-url") return copy.rejected;
  if (isTlsFailure(code)) return copy.certificate;
  if (/^(provider-|fetch failed|net::)/i.test(code)) return copy.server;
  return null;
}
module.exports = { providerHttpError, providerDiagnosticError };
