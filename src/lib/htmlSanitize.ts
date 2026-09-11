import DOMPurify from "dompurify";

/**
 * 匯入與 AI 產出共用的 HTML 清理。
 *
 * 保留：標題、段落、換行、粗斜體／刪除線、清單、核取清單、引用、程式碼、
 * 分隔線、表格、連結與安全圖片。
 * 移除：script、iframe、object、embed、style、form、SVG、事件屬性、
 * `javascript:` 與所有非 http(s)／attachment 的協定。
 */
export const SAFE_TAGS = [
  "p", "br", "hr", "span", "div", "strong", "b", "em", "i", "del", "s", "ins", "u", "sub", "sup", "mark",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "label", "input",
  "blockquote", "code", "pre", "kbd", "samp", "var",
  "a", "img", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
];

export const SAFE_ATTRS = [
  "href", "title", "alt", "src", "colspan", "rowspan", "start", "type", "checked", "disabled",
  "data-type", "data-task-id", "data-card-id", "data-attachment-id", "data-missing-attachment", "target", "rel", "align",
];

const FORBIDDEN_URI = /^(?:javascript|vbscript|data|blob|file|chrome|resource):/i;

/**
 * DOMPurify 的協議白名單。
 *
 * 預設協定之外放行 `attachment:`，否則卡片內部表示 `attachment://<id>`
 * 會在清理階段被剝掉 src，內嵌圖片隨之被 ProseMirror 丟棄；
 * 尾段仍沿用預設規則放行相對路徑與無協定值。
 */
const ALLOWED_URI_PATTERN = /^(?:(?:data:image\/(?:png|jpe?g|webp|gif|avif|bmp|svg\+xml)(?:;[^,]*)?,)|(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|attachment):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
const SAFE_SVG_DATA_IMAGE = /^data:image\/svg\+xml(?:;[^,]*)?,[\s\S]+$/i;

export function isSafeDataImage(value: string) {
  return SAFE_DATA_IMAGE.test(String(value || "").trim()) || SAFE_SVG_DATA_IMAGE.test(String(value || "").trim());
}

export function isSafeUri(value: string, { allowAttachment = true, allowDataImage = false }: { allowAttachment?: boolean; allowDataImage?: boolean } = {}) {
  const uri = String(value || "").trim();
  if (!uri) return false;
  if (allowAttachment && uri.startsWith("attachment://")) return true;
  // data URL 圖片只在匯入當下允許，隨後立刻轉成附件，絕不留存長字串。
  if (allowDataImage && isSafeDataImage(uri)) return true;
  if (FORBIDDEN_URI.test(uri)) return false;
  return /^(?:https?:)?\/\//i.test(uri) || uri.startsWith("/") || uri.startsWith("./") || uri.startsWith("../");
}

/** 遠端圖片未获授权时，保留 alt 与网址作为可读占位，绝不留下会连线的标签。 */
export function remoteImagePlaceholder(alt: string, url: string) {
  const label = alt.trim() || url;
  return `[${label}](${url})`;
}

let installed = false;
let hookAllowDataImages = false;

function installHooks() {
  if (installed) return;
  installed = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const element = node as HTMLElement;
    if (element.tagName === "A") {
      const href = element.getAttribute("href") || "";
      if (!isSafeUri(href)) element.removeAttribute("href");
      else if (/^https?:\/\//i.test(href)) {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (element.tagName === "IMG") {
      const src = element.getAttribute("src") || "";
      if (!isSafeUri(src, { allowDataImage: hookAllowDataImages })) {
        element.setAttribute("data-blocked-src", src.slice(0, 512));
        element.removeAttribute("src");
      }
    }
  });
}

/** 找出文件裡所有網路圖片，供匯入介面先列出來源網域徵求同意。 */
export function findRemoteImages(html: string) {
  const document = new DOMParser().parseFromString(html || "", "text/html");
  const urls: string[] = [];
  document.body.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src") || "";
    if (/^https?:\/\//i.test(src) && !urls.includes(src)) urls.push(src);
  });
  return urls;
}

export function sanitizeImportHtml(html: string, options: { allowRemoteImages?: boolean; allowDataImages?: boolean } = {}) {
  installHooks();
  const allowDataImages = options.allowDataImages === true;
  hookAllowDataImages = allowDataImages;
  const sanitized = DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS: SAFE_TAGS,
    ALLOWED_ATTR: SAFE_ATTRS,
    ALLOW_DATA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: ALLOWED_URI_PATTERN,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "svg", "math", "link", "meta", "base", "noscript", "template", "audio", "video", "canvas", "frame", "frameset"],
    FORBID_ATTR: ["style", "srcdoc", "formaction", "autofocus", "ping", "xlink:href"],
    KEEP_CONTENT: true,
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  // DOMPurify 已移除事件屬性；這裡再補一刀，確保大小寫混寫與巢狀寫法都攔得住。
  document.body.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "style" || name === "srcdoc") element.removeAttribute(attribute.name);
      if (name === "href" && /^\s*(?:javascript|vbscript|data):/i.test(attribute.value)) element.removeAttribute(attribute.name);
      if (name === "src" && /^\s*data:/i.test(attribute.value) && !isSafeUri(attribute.value, { allowDataImage: allowDataImages })) element.removeAttribute(attribute.name);
    });
  });
  if (!options.allowRemoteImages) {
    document.body.querySelectorAll("img[src]").forEach((image) => {
      const src = image.getAttribute("src") || "";
      if (!/^https?:\/\//i.test(src)) return;
      const text = document.createTextNode(remoteImagePlaceholder(image.getAttribute("alt") || "", src));
      image.replaceWith(text);
    });
  }
  return document.body.innerHTML || "<p></p>";
}

export function htmlToPlainText(html: string) {
  const document = new DOMParser().parseFromString(html || "", "text/html");
  document.body.querySelectorAll("script,style").forEach((element) => element.remove());
  return (document.body.textContent || "").replace(/\u00a0/g, " ").trim();
}
