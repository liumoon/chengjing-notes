import type { AppLanguage } from "../types";
import type { BackupInspection } from "./backupValidation";

const copy = {
  "zh-TW": {
    title: "備份預檢",
    version: (value: number) => `格式 v${value}`,
    cards: (value: number) => `${value} 張卡片`,
    attachments: (value: number) => `${value} 個附件`,
    tasks: (value: number) => `${value} 個待辦`,
    boards: (value: number) => `${value} 個白板`,
    ready: "可以還原。還原前會先保留安全副本。",
    warning: (value: number) => `有 ${value} 個附件引用找不到對應檔案；其他資料仍可還原。`,
    confirm: "已完成備份預檢。確定要繼續還原嗎？",
  },
  "zh-CN": {
    title: "备份预检",
    version: (value: number) => `格式 v${value}`,
    cards: (value: number) => `${value} 张卡片`,
    attachments: (value: number) => `${value} 个附件`,
    tasks: (value: number) => `${value} 个待办`,
    boards: (value: number) => `${value} 个白板`,
    ready: "可以恢复。恢复前会先保留安全副本。",
    warning: (value: number) => `有 ${value} 个附件引用找不到对应文件；其他数据仍可恢复。`,
    confirm: "已完成备份预检。确定要继续恢复吗？",
  },
  en: {
    title: "Backup preflight",
    version: (value: number) => `Format v${value}`,
    cards: (value: number) => `${value} card${value === 1 ? "" : "s"}`,
    attachments: (value: number) => `${value} attachment${value === 1 ? "" : "s"}`,
    tasks: (value: number) => `${value} task${value === 1 ? "" : "s"}`,
    boards: (value: number) => `${value} board${value === 1 ? "" : "s"}`,
    ready: "Ready to restore. A safety copy will be kept first.",
    warning: (value: number) => `${value} attachment reference${value === 1 ? "" : "s"} have no matching file; other data can still be restored.`,
    confirm: "Backup preflight is complete. Continue restoring?",
  },
  ja: {
    title: "バックアップ事前確認",
    version: (value: number) => `形式 v${value}`,
    cards: (value: number) => `カード ${value}件`,
    attachments: (value: number) => `添付 ${value}件`,
    tasks: (value: number) => `タスク ${value}件`,
    boards: (value: number) => `ボード ${value}件`,
    ready: "復元できます。先に安全コピーを保存します。",
    warning: (value: number) => `${value}件の添付参照に対応するファイルがありません。他のデータは復元できます。`,
    confirm: "バックアップの事前確認が完了しました。復元を続けますか？",
  },
  ko: {
    title: "백업 사전 점검",
    version: (value: number) => `형식 v${value}`,
    cards: (value: number) => `카드 ${value}개`,
    attachments: (value: number) => `첨부 파일 ${value}개`,
    tasks: (value: number) => `할 일 ${value}개`,
    boards: (value: number) => `보드 ${value}개`,
    ready: "복원할 수 있습니다. 먼저 안전 사본을 보관합니다.",
    warning: (value: number) => `${value}개 첨부 참조에 해당하는 파일이 없습니다. 다른 데이터는 복원할 수 있습니다.`,
    confirm: "백업 사전 점검이 완료되었습니다. 복원을 계속할까요?",
  },
} as const;

export function getBackupInspectionCopy(language: AppLanguage) {
  return copy[language] || copy.en;
}

export function backupInspectionMessage(inspection: BackupInspection, language: AppLanguage) {
  const text = getBackupInspectionCopy(language);
  return inspection.missingAttachmentIds.length ? text.warning(inspection.missingAttachmentIds.length) : text.ready;
}
