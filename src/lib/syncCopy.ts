import type { AppLanguage } from "../types";
import type { SyncErrorKind } from "./syncErrors";

const copy = {
  "zh-TW": {
    pending: (value: number) => `待同步 ${value} 筆`,
    pendingAttachments: (value: number) => `其中 ${value} 個附件待上傳`,
    noPending: "目前沒有待同步內容。",
    errorTitle: "同步尚未完成",
    category: {
      network: "網路連線或服務暫時無法使用",
      auth: "Google 登入已失效",
      "attachment-upload": "附件上傳失敗",
      "attachment-download": "附件下載失敗",
      protocol: "同步資料驗證失敗",
      permission: "Google Drive 權限不足",
      unknown: "同步發生未預期錯誤",
    } satisfies Record<SyncErrorKind, string>,
    retry: "可確認網路或登入狀態後，再按「立即同步」重試。待同步內容會先保留在這台裝置。",
    noRetry: "請確認 Google 帳號與 Drive 權限後再重新連線。待同步內容會先保留在這台裝置。",
    attachmentHint: "附件檔案會在內容同步完成前保留，不會因這次失敗而刪除。",
  },
  "zh-CN": {
    pending: (value: number) => `待同步 ${value} 条`,
    pendingAttachments: (value: number) => `其中 ${value} 个附件待上传`,
    noPending: "目前没有待同步内容。",
    errorTitle: "同步尚未完成",
    category: {
      network: "网络连接或服务暂时不可用",
      auth: "Google 登录已失效",
      "attachment-upload": "附件上传失败",
      "attachment-download": "附件下载失败",
      protocol: "同步数据验证失败",
      permission: "Google Drive 权限不足",
      unknown: "同步发生未预期错误",
    } satisfies Record<SyncErrorKind, string>,
    retry: "确认网络或登录状态后，再点“立即同步”重试。待同步内容会先保留在这台设备。",
    noRetry: "请确认 Google 账号和 Drive 权限后重新连接。待同步内容会先保留在这台设备。",
    attachmentHint: "附件会在内容同步完成前保留，不会因这次失败而删除。",
  },
  en: {
    pending: (value: number) => `${value} item${value === 1 ? "" : "s"} waiting to sync`,
    pendingAttachments: (value: number) => `${value} attachment${value === 1 ? "" : "s"} waiting to upload`,
    noPending: "There is no local content waiting to sync.",
    errorTitle: "Sync is incomplete",
    category: {
      network: "The network or sync service is temporarily unavailable",
      auth: "Google sign-in has expired",
      "attachment-upload": "Attachment upload failed",
      "attachment-download": "Attachment download failed",
      protocol: "Sync data validation failed",
      permission: "Google Drive permission was denied",
      unknown: "An unexpected sync error occurred",
    } satisfies Record<SyncErrorKind, string>,
    retry: "Check the network or sign-in state, then press “Sync now” to retry. Pending content stays on this device.",
    noRetry: "Check the Google Account and Drive permissions, then reconnect. Pending content stays on this device.",
    attachmentHint: "Attachments stay on this device until the content sync completes; this failure does not delete them.",
  },
  ja: {
    pending: (value: number) => `同期待ち ${value}件`,
    pendingAttachments: (value: number) => `うち添付 ${value}件をアップロード待ち`,
    noPending: "同期待ちの内容はありません。",
    errorTitle: "同期が完了していません",
    category: {
      network: "ネットワークまたは同期サービスが一時的に利用できません",
      auth: "Googleのログインが期限切れです",
      "attachment-upload": "添付ファイルのアップロードに失敗しました",
      "attachment-download": "添付ファイルのダウンロードに失敗しました",
      protocol: "同期データの検証に失敗しました",
      permission: "Google Driveの権限がありません",
      unknown: "予期しない同期エラーが発生しました",
    } satisfies Record<SyncErrorKind, string>,
    retry: "ネットワークまたはログイン状態を確認し、「今すぐ同期」を押して再試行してください。待機中の内容はこの端末に残ります。",
    noRetry: "GoogleアカウントとDriveの権限を確認してから再接続してください。待機中の内容はこの端末に残ります。",
    attachmentHint: "同期が完了するまで添付ファイルはこの端末に残り、この失敗によって削除されません。",
  },
  ko: {
    pending: (value: number) => `동기화 대기 ${value}개`,
    pendingAttachments: (value: number) => `그중 첨부 파일 ${value}개 업로드 대기`,
    noPending: "동기화 대기 중인 콘텐츠가 없습니다.",
    errorTitle: "동기화가 완료되지 않았습니다",
    category: {
      network: "네트워크 또는 동기화 서비스를 일시적으로 사용할 수 없습니다",
      auth: "Google 로그인이 만료되었습니다",
      "attachment-upload": "첨부 파일 업로드에 실패했습니다",
      "attachment-download": "첨부 파일 다운로드에 실패했습니다",
      protocol: "동기화 데이터 검증에 실패했습니다",
      permission: "Google Drive 권한이 없습니다",
      unknown: "예상하지 못한 동기화 오류가 발생했습니다",
    } satisfies Record<SyncErrorKind, string>,
    retry: "네트워크나 로그인 상태를 확인한 뒤 ‘지금 동기화’를 눌러 다시 시도하세요. 대기 중인 콘텐츠는 이 기기에 남습니다.",
    noRetry: "Google 계정과 Drive 권한을 확인한 뒤 다시 연결하세요. 대기 중인 콘텐츠는 이 기기에 남습니다.",
    attachmentHint: "동기화가 완료될 때까지 첨부 파일은 이 기기에 남으며 이번 실패로 삭제되지 않습니다.",
  },
} as const;

export function getSyncCopy(language: AppLanguage) {
  return copy[language] || copy.en;
}
