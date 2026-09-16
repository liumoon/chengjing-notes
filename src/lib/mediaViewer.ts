export interface MediaViewerRequest {
  src: string;
  alt?: string;
  /** SVG 附件另提供「編輯原始碼」與「複製其中文字」入口。 */
  attachmentId?: string;
  /** SVG 原始碼；拿得到才能選取文字、複製與編輯。 */
  svg?: string;
  /**
   * 儲存編輯後的 SVG。實作一律「新增一份附件」而不是覆蓋原檔，
   * 使用者隨時还能拿回原本的圖。
   */
  onSaveSvg?: (source: string) => Promise<boolean>;
}

export const MEDIA_VIEWER_EVENT = "chengjing:media-viewer";

/** 正文、Markdown 預覽與附件縮圖共用的放大檢視入口。 */
export function openMediaViewer(request: MediaViewerRequest) {
  if (!request.src) return;
  window.dispatchEvent(new CustomEvent<MediaViewerRequest>(MEDIA_VIEWER_EVENT, { detail: request }));
}
