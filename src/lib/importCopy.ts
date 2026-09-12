import type { AppLanguage } from "../types";

/**
 * Markdown 雙模式與文件匯入的五語文案。
 *
 * 集中在此而不是散落在元件裡，方便逐字校對繁中／簡中／英／日／韓，
 * 也確保同一個狀態在桌面與 Android 顯示同一句話。
 */
export interface ImportCopy {
  modeRich: string;
  modeMarkdown: string;
  modeHint: string;
  markdownSearch: string;
  markdownSearchNext: string;
  markdownSearchPrevious: string;
  markdownSearchEmpty: string;
  markdownTabHint: string;
  pasteImageSaving: string;
  pasteImageFailed: string;
  switching: string;
  converting: string;
  importTitle: string;
  importDropHint: string;
  importChooseFiles: string;
  importProgress: string;
  importReading: string;
  importParsing: string;
  importSaving: string;
  importDone: string;
  importPartial: string;
  importFailedAll: string;
  importOpenCard: string;
  importSummary: string;
  importSucceeded: string;
  importFailed: string;
  importSkipped: string;
  importRetry: string;
  remoteConsentTitle: string;
  remoteConsentBody: string;
  remoteConsentAllow: string;
  remoteConsentKeep: string;
  remoteHosts: string;
  warningNoText: string;
  warningTruncated: string;
  warningTooLarge: string;
  warningBlockedHtml: string;
  warningRemoteBlocked: string;
  warningImageTooLarge: string;
  warningImageRejected: string;
  warningAssetMissing: string;
  warningPathTraversal: string;
  warningSvgRejected: string;
  warningSvgSanitized: string;
  warningUnsupported: string;
  warningMammoth: string;
  warningMarkdownFallback: string;
  warningTasksRecreated: string;
  errorCorrupted: string;
  errorEncrypted: string;
  errorParse: string;
  errorSave: string;
  errorNetwork: string;
  errorTimeout: string;
  errorUnsupportedType: string;
  warningCleanupFailed: string;
  sourceAttachment: string;
  inlineImage: string;
  plainAttachment: string;
  exportMarkdown: string;
  exportMarkdownDone: string;
  exportMarkdownFailed: string;
  exportZip: string;
}

const zhTW: ImportCopy = {
  modeRich: "富文字", modeMarkdown: "Markdown", modeHint: "Markdown 會保留標題、清單、表格與程式碼的結構，空白與標記風格可能正規化。",
  markdownSearch: "在卡片內搜尋", markdownSearchNext: "下一筆", markdownSearchPrevious: "上一筆", markdownSearchEmpty: "找不到符合的文字", markdownTabHint: "Tab 縮排",
  pasteImageSaving: "正在保存貼上的圖片…", pasteImageFailed: "貼上圖片保存失敗，請稍後再試。",
  switching: "切換編輯模式…", converting: "轉換內容格式…",
  importTitle: "匯入文件", importDropHint: "把檔案拖進來，或選擇檔案", importChooseFiles: "選擇檔案",
  importProgress: "匯入 {done}/{total}", importReading: "讀取 {name}…", importParsing: "解析 {name}…", importSaving: "保存 {name}…",
  importDone: "已匯入 {count} 份文件。", importPartial: "{done} 份成功、{failed} 份失敗。", importFailedAll: "這批檔案都沒有成功匯入。",
  importOpenCard: "開啟卡片", importSummary: "匯入結果", importSucceeded: "成功", importFailed: "失敗", importSkipped: "已略過", importRetry: "重試",
  remoteConsentTitle: "要下載文件裡的網路圖片嗎？", remoteConsentBody: "發現 {count} 張網路圖片，來自以下網域。澄境預設不下載，避免載入追蹤圖片。",
  remoteConsentAllow: "下載並保存到本機", remoteConsentKeep: "保留文字占位", remoteHosts: "來源網域",
  warningNoText: "未擷取到文字（可能是掃描式 PDF）。原檔已保留，可直接開啟閱讀。",
  warningTruncated: "文件過長，已保留可解析的部分。", warningTooLarge: "檔案超過大小上限，已跳過。",
  warningBlockedHtml: "已移除不安全的 HTML（腳本、iframe、樣式或事件屬性）。", warningRemoteBlocked: "網路圖片未下載，已改成文字占位。",
  warningImageTooLarge: "圖片超過 10 MB，已保留網址占位。", warningImageRejected: "內容不是圖片，已略過。", warningAssetMissing: "找不到內嵌圖片，已改成文字占位。", warningPathTraversal: "已移除指向外部的相對路徑，避免讀取資料夾外的檔案。",
  warningSvgRejected: "SVG 含有無法安全清理的內容，已保留原檔但未嵌入正文。", warningSvgSanitized: "SVG 中不安全的元素或屬性已移除，已保存清理後的內嵌圖片。",
  warningUnsupported: "不支援的檔案格式，已保留為一般附件。", warningMammoth: "Word 文件部分內容無法解析：{detail}",
  warningMarkdownFallback: "Markdown 引擎降級，格式可能簡化。", warningTasksRecreated: "{count} 個待辦無法對應，已建立新的識別。",
  errorCorrupted: "檔案已損毀，無法解析。", errorEncrypted: "檔案已加密，請先解除密碼保護。", errorParse: "解析失敗。", errorSave: "保存失敗。",
  errorNetwork: "網路連線失敗。", errorTimeout: "下載逾時。", errorUnsupportedType: "不支援的檔案類型。", warningCleanupFailed: "匯入失敗後有附件未能清理，請使用附件健康中心檢查。",
  sourceAttachment: "原始文件", inlineImage: "內嵌圖片", plainAttachment: "附件",
  exportMarkdown: "匯出 Markdown", exportMarkdownDone: "已匯出 {name}。", exportMarkdownFailed: "匯出 Markdown 失敗。", exportZip: "含圖片的 ZIP",
};

const zhCN: ImportCopy = {
  ...zhTW,
  modeRich: "富文本", modeMarkdown: "Markdown", modeHint: "Markdown 会保留标题、列表、表格与代码的结构，空白与标记风格可能被规范化。",
  markdownSearch: "在卡片内搜索", markdownSearchNext: "下一处", markdownSearchPrevious: "上一处", markdownSearchEmpty: "未找到匹配的文字", markdownTabHint: "Tab 缩进",
  pasteImageSaving: "正在保存粘贴的图片…", pasteImageFailed: "粘贴图片保存失败，请稍后重试。",
  switching: "切换编辑模式…", converting: "转换内容格式…",
  importTitle: "导入文档", importDropHint: "把文件拖进来，或选择文件", importChooseFiles: "选择文件",
  importProgress: "导入 {done}/{total}", importReading: "读取 {name}…", importParsing: "解析 {name}…", importSaving: "保存 {name}…",
  importDone: "已导入 {count} 份文档。", importPartial: "{done} 份成功、{failed} 份失败。", importFailedAll: "这批文件都没有成功导入。",
  importOpenCard: "打开卡片", importSummary: "导入结果", importSucceeded: "成功", importFailed: "失败", importSkipped: "已跳过", importRetry: "重试",
  remoteConsentTitle: "要下载文档里的网络图片吗？", remoteConsentBody: "发现 {count} 张网络图片，来自以下域名。澄境默认不下载，避免加载追踪图片。",
  remoteConsentAllow: "下载并保存到本机", remoteConsentKeep: "保留文字占位", remoteHosts: "来源域名",
  warningNoText: "未提取到文字（可能是扫描版 PDF）。原文件已保留，可直接打开阅读。",
  warningTruncated: "文档过长，已保留可解析的部分。", warningTooLarge: "文件超过大小上限，已跳过。",
  warningBlockedHtml: "已移除不安全的 HTML（脚本、iframe、样式或事件属性）。", warningRemoteBlocked: "网络图片未下载，已改为文字占位。",
  warningImageTooLarge: "图片超过 10 MB，已保留网址占位。", warningImageRejected: "内容不是图片，已跳过。", warningAssetMissing: "找不到嵌入图片，已改为文字占位。", warningPathTraversal: "已移除指向外部的相对路径，避免读取文件夹外的文件。",
  warningSvgRejected: "SVG 包含无法安全清理的内容，已保留原文件但未嵌入正文。", warningSvgSanitized: "SVG 中不安全的元素或属性已移除，已保存清理后的内嵌图片。",
  warningUnsupported: "不支持的文件格式，已保留为普通附件。", warningMammoth: "Word 文档部分内容无法解析：{detail}",
  warningMarkdownFallback: "Markdown 引擎降级，格式可能简化。", warningTasksRecreated: "{count} 个待办无法对应，已创建新的标识。",
  errorCorrupted: "文件已损坏，无法解析。", errorEncrypted: "文件已加密，请先解除密码保护。", errorParse: "解析失败。", errorSave: "保存失败。",
  errorNetwork: "网络连接失败。", errorTimeout: "下载超时。", errorUnsupportedType: "不支持的文件类型。",
  sourceAttachment: "原始文档", inlineImage: "内嵌图片", plainAttachment: "附件",
  exportMarkdown: "导出 Markdown", exportMarkdownDone: "已导出 {name}。", exportMarkdownFailed: "导出 Markdown 失败。", exportZip: "含图片的 ZIP",
};

const en: ImportCopy = {
  modeRich: "Rich text", modeMarkdown: "Markdown", modeHint: "Markdown keeps headings, lists, tables and code blocks. Whitespace and marker styles may be normalized.",
  markdownSearch: "Search in card", markdownSearchNext: "Next match", markdownSearchPrevious: "Previous match", markdownSearchEmpty: "No matches found", markdownTabHint: "Tab to indent",
  pasteImageSaving: "Saving pasted image…", pasteImageFailed: "Could not save the pasted image. Try again.",
  switching: "Switching editor mode…", converting: "Converting content…",
  importTitle: "Import documents", importDropHint: "Drop files here, or choose files", importChooseFiles: "Choose files",
  importProgress: "Importing {done}/{total}", importReading: "Reading {name}…", importParsing: "Parsing {name}…", importSaving: "Saving {name}…",
  importDone: "Imported {count} documents.", importPartial: "{done} succeeded, {failed} failed.", importFailedAll: "None of these files were imported.",
  importOpenCard: "Open card", importSummary: "Import results", importSucceeded: "Succeeded", importFailed: "Failed", importSkipped: "Skipped", importRetry: "Retry",
  remoteConsentTitle: "Download images from the web?", remoteConsentBody: "Found {count} remote images from these domains. ChengJing does not download them by default, so tracking pixels never load.",
  remoteConsentAllow: "Download and store locally", remoteConsentKeep: "Keep text placeholders", remoteHosts: "Source domains",
  warningNoText: "No text extracted (possibly a scanned PDF). The original file is kept and can be opened directly.",
  warningTruncated: "The document was too long; only the parseable part was kept.", warningTooLarge: "The file exceeded the size limit and was skipped.",
  warningBlockedHtml: "Unsafe HTML was removed (scripts, iframes, styles or event attributes).", warningRemoteBlocked: "Remote images were not downloaded and became text placeholders.",
  warningImageTooLarge: "An image exceeded 10 MB; its URL was kept as a placeholder.", warningImageRejected: "Content was not an image and was skipped.", warningAssetMissing: "Embedded images could not be found and became text placeholders.", warningPathTraversal: "Relative paths pointing outside the document folder were removed.",
  warningSvgRejected: "The SVG contained content that could not be sanitized safely; the original was kept but not embedded.", warningSvgSanitized: "Unsafe SVG elements or attributes were removed; a sanitized inline image was saved.",
  warningUnsupported: "Unsupported format; kept as a plain attachment.", warningMammoth: "Some Word content could not be parsed: {detail}",
  warningMarkdownFallback: "Markdown engine fell back; formatting may be simplified.", warningTasksRecreated: "{count} tasks could not be matched and got new identifiers.",
  errorCorrupted: "The file is corrupted and could not be parsed.", errorEncrypted: "The file is encrypted. Remove the password first.", errorParse: "Parsing failed.", errorSave: "Saving failed.",
  errorNetwork: "Network request failed.", errorTimeout: "Download timed out.", errorUnsupportedType: "Unsupported file type.", warningCleanupFailed: "Some attachments could not be cleaned up after the import failed. Check the attachment health center.",
  sourceAttachment: "Source document", inlineImage: "Inline image", plainAttachment: "Attachment",
  exportMarkdown: "Export Markdown", exportMarkdownDone: "Exported {name}.", exportMarkdownFailed: "Markdown export failed.", exportZip: "ZIP with images",
};

const ja: ImportCopy = {
  modeRich: "リッチテキスト", modeMarkdown: "Markdown", modeHint: "Markdown は見出し・リスト・表・コードブロックの構造を保持します。空白や記号の書式は正規化される場合があります。",
  markdownSearch: "カード内を検索", markdownSearchNext: "次へ", markdownSearchPrevious: "前へ", markdownSearchEmpty: "一致する文字が見つかりません", markdownTabHint: "Tab でインデント",
  pasteImageSaving: "貼り付けた画像を保存しています…", pasteImageFailed: "貼り付けた画像を保存できませんでした。もう一度お試しください。",
  switching: "編集モードを切り替えています…", converting: "コンテンツを変換しています…",
  importTitle: "ドキュメントを取り込む", importDropHint: "ファイルをドラッグするか、選択してください", importChooseFiles: "ファイルを選択",
  importProgress: "取り込み中 {done}/{total}", importReading: "{name} を読み込んでいます…", importParsing: "{name} を解析しています…", importSaving: "{name} を保存しています…",
  importDone: "{count} 件を取り込みました。", importPartial: "{done} 件成功、{failed} 件失敗しました。", importFailedAll: "このファイル群は取り込めませんでした。",
  importOpenCard: "カードを開く", importSummary: "取り込み結果", importSucceeded: "成功", importFailed: "失敗", importSkipped: "スキップ", importRetry: "再試行",
  remoteConsentTitle: "Web 上の画像をダウンロードしますか？", remoteConsentBody: "{count} 枚のremote画像を次のドメインで検出しました。追跡画像を読み込まないよう、既定ではダウンロードしません。",
  remoteConsentAllow: "ダウンロードして端末に保存", remoteConsentKeep: "テキストのプレースホルダーを保持", remoteHosts: "参照元ドメイン",
  warningNoText: "テキストを抽出できませんでした（スキャン PDF の可能性があります）。原本は保存済みです。",
  warningTruncated: "長すぎるため、解析できた部分のみ保持しました。", warningTooLarge: "サイズ上限を超えたためスキップしました。",
  warningBlockedHtml: "安全でない HTML（スクリプト、iframe、スタイル、イベント属性）を削除しました。", warningRemoteBlocked: "remote画像はダウンロードせず、テキストのプレースホルダーにしました。",
  warningImageTooLarge: "画像が 10 MB を超えたため URL をプレースホルダーとして保持しました。", warningImageRejected: "画像ではないためスキップしました。", warningAssetMissing: "埋め込み画像が見つからなかったため、テキストのプレースホルダーにしました。", warningPathTraversal: "フォルダー外を指す相対パスは削除しました。",
  warningSvgRejected: "安全にサニタイズできない内容を含む SVG のため、原本のみ保存し本文には埋め込みませんでした。", warningSvgSanitized: "SVG の安全でない要素や属性を削除し、サニタイズ済み画像を保存しました。",
  warningUnsupported: "未対応の形式のため、通常の添付として保存しました。", warningMammoth: "Word の一部を解析できませんでした：{detail}",
  warningMarkdownFallback: "Markdown エンジンがフォールバックし、書式が簡略化される場合があります。", warningTasksRecreated: "{count} 件のタスクを対応付けできず、新しい識別子を作成しました。",
  errorCorrupted: "ファイルが破損しており解析できません。", errorEncrypted: "ファイルが暗号化されています。パスワードを解除してください。", errorParse: "解析に失敗しました。", errorSave: "保存に失敗しました。",
  errorNetwork: "ネットワーク接続に失敗しました。", errorTimeout: "ダウンロードがタイムアウトしました。", errorUnsupportedType: "未対応のファイル形式です。", warningCleanupFailed: "取り込み失敗後に整理できない添付がありました。添付ファイルの状態センターを確認してください。",
  sourceAttachment: "原本ドキュメント", inlineImage: "インライン画像", plainAttachment: "添付ファイル",
  exportMarkdown: "Markdown を書き出す", exportMarkdownDone: "{name} を書き出しました。", exportMarkdownFailed: "Markdown の書き出しに失敗しました。", exportZip: "画像を含む ZIP",
};

const ko: ImportCopy = {
  modeRich: "리치 텍스트", modeMarkdown: "Markdown", modeHint: "Markdown은 제목, 목록, 표, 코드 블록의 구조를 보존합니다. 공백과 표기 스타일은 정규화될 수 있습니다.",
  markdownSearch: "카드에서 검색", markdownSearchNext: "다음", markdownSearchPrevious: "이전", markdownSearchEmpty: "일치하는 텍스트가 없습니다", markdownTabHint: "Tab으로 들여쓰기",
  pasteImageSaving: "붙여넣은 이미지를 저장하는 중…", pasteImageFailed: "붙여넣은 이미지를 저장하지 못했습니다. 다시 시도하세요.",
  switching: "편집 모드 전환 중…", converting: "내용 변환 중…",
  importTitle: "문서 가져오기", importDropHint: "파일을 끌어놓거나 파일을 선택하세요", importChooseFiles: "파일 선택",
  importProgress: "가져오는 중 {done}/{total}", importReading: "{name} 읽는 중…", importParsing: "{name} 분석 중…", importSaving: "{name} 저장 중…",
  importDone: "{count}개 문서를 가져왔습니다.", importPartial: "{done}개 성공, {failed}개 실패했습니다.", importFailedAll: "이 파일들은 가져오지 못했습니다.",
  importOpenCard: "카드 열기", importSummary: "가져오기 결과", importSucceeded: "성공", importFailed: "실패", importSkipped: "건너뜀", importRetry: "다시 시도",
  remoteConsentTitle: "웹의 이미지를 다운로드할까요?", remoteConsentBody: "다음 도메인에서 {count}장의 이미지를 찾았습니다. 추적 이미지 로딩을 막기 위해 기본값은 다운로드하지 않습니다.",
  remoteConsentAllow: "다운로드하여 기기에 저장", remoteConsentKeep: "텍스트 자리표시자 유지", remoteHosts: "출처 도메인",
  warningNoText: "텍스트를 추출하지 못했습니다(스캔 PDF일 수 있습니다). 원본은 보관되어 바로 열 수 있습니다.",
  warningTruncated: "문서가 길어서 분석된 부분만 보관했습니다.", warningTooLarge: "파일이 크기 제한을 넘어 건너뛰었습니다.",
  warningBlockedHtml: "부적절한 HTML(스크립트, iframe, 스타일, 이벤트 속성)을 제거했습니다.", warningRemoteBlocked: "웹 이미지는 다운로드하지 않고 텍스트 자리표시자로 바꿨습니다.",
  warningImageTooLarge: "이미지가 10MB를 넘어 URL을 자리표시자로 보관했습니다.", warningImageRejected: "이미지가 아니라 건너뛰었습니다.", warningAssetMissing: "삽입 이미지를 찾을 수 없어 텍스트 자리표시자로 바꿨습니다.", warningPathTraversal: "폴더 밖을 가리키는 상대 경로는 삭제했습니다.",
  warningSvgRejected: "안전하게 정제할 수 없는 내용이 포함된 SVG라 원본만 보관하고 본문에는 삽입하지 않았습니다.", warningSvgSanitized: "SVG의 안전하지 않은 요소나 속성을 제거하고 정제된 본문 이미지를 저장했습니다.",
  warningUnsupported: "지원하지 않는 형식이므로 일반 첨부로 보관했습니다.", warningMammoth: "Word 내용의 일부를 분석할 수 없습니다: {detail}",
  warningMarkdownFallback: "Markdown 엔진이 대체 경로로 동작하여 서식이 단순화될 수 있습니다.", warningTasksRecreated: "{count}개 할 일을 대응하지 못해 새 식별자를 만들었습니다.",
  errorCorrupted: "파일이 손상되어 분석할 수 없습니다.", errorEncrypted: "파일이 암호화되어 있습니다. 먼저 비밀번호를 해제하세요.", errorParse: "분석에 실패했습니다.", errorSave: "저장에 실패했습니다.",
  errorNetwork: "네트워크 연결에 실패했습니다.", errorTimeout: "다운로드 시간이 초과되었습니다.", errorUnsupportedType: "지원하지 않는 파일 형식입니다.", warningCleanupFailed: "가져오기 실패 후 일부 첨부를 정리하지 못했습니다. 첨부 파일 상태 센터를 확인하세요.",
  sourceAttachment: "원본 문서", inlineImage: "본문 이미지", plainAttachment: "첨부 파일",
  exportMarkdown: "Markdown 내보내기", exportMarkdownDone: "{name}을(를) 내보냈습니다.", exportMarkdownFailed: "Markdown 내보내기에 실패했습니다.", exportZip: "이미지가 포함된 ZIP",
};

const dictionaries: Record<AppLanguage, ImportCopy> = { "zh-TW": zhTW, "zh-CN": zhCN, en, ja, ko };

export function getImportCopy(language: AppLanguage): ImportCopy {
  return dictionaries[language] || zhTW;
}

export const importCopyKeys = Object.keys(zhTW) as Array<keyof ImportCopy>;

/** 解析警告代碼 → 五語文案。 */
export function importWarningCopy(language: AppLanguage, code: string): string {
  const copy = getImportCopy(language);
  const matched = code.match(/^tasks-recreated:(\d+)$/);
  if (matched) return copy.warningTasksRecreated.replace("{count}", matched[1]);
  if (code === "markdown-engine-fallback" || code === "markdown-engine") return copy.warningMarkdownFallback;
  if (code === "remote-images-blocked") return copy.warningRemoteBlocked;
  if (code === "blocked-html") return copy.warningBlockedHtml;
  if (code === "no-text") return copy.warningNoText;
  if (code === "too-large") return copy.warningTooLarge;
  if (code === "truncated") return copy.warningTruncated;
  if (code === "image-too-large") return copy.warningImageTooLarge;
  if (code === "image-rejected") return copy.warningImageRejected;
  if (code === "asset-missing") return copy.warningAssetMissing;
  if (code === "path-traversal") return copy.warningPathTraversal;
  if (code === "svg-rejected") return copy.warningSvgRejected;
  if (code === "svg-sanitized") return copy.warningSvgSanitized;
  if (code.startsWith("mammoth:")) return copy.warningMammoth.replace("{detail}", code.slice("mammoth:".length).trim() || code);
  if (code === "unsupported") return copy.warningUnsupported;
  if (code.startsWith("cleanup-failed:")) return copy.warningCleanupFailed;
  return code;
}
