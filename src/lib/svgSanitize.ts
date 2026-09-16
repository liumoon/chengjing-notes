import { IMPORT_LIMITS } from "./importLimits";

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/svg+xml",
]);

const SAFE_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
  "marker",
  "mask",
]);

const SAFE_ATTRIBUTES = new Set([
  "xmlns",
  "viewbox",
  "width",
  "height",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "transform",
  "d",
  "points",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "id",
  "class",
  "text-anchor",
  "dominant-baseline",
  "font-size",
  "font-weight",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "fx",
  "fy",
  "preserveaspectratio",
  "clip-path",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
  "paint-order",
  "clip-rule",
  "color",
  "letter-spacing",
  "font-family",
  "font-style",
  "font-stretch",
  "xml:space",
]);

const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const DANGEROUS_VALUE = /(?:javascript\s*:|vbscript\s*:|data\s*:|blob\s*:|file\s*:|https?:\/\/|@import|<|>)/i;
/** `url(#id)` 指向同一份 SVG 裡的漸層／遮罩／裁剪；外部一律拒絕。 */
const URL_REFERENCE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const LOCAL_FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const REFERENCE_ATTRIBUTES = new Set([
  "fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end", "fill-opacity",
]);

export interface SanitizedSvg {
  svg: string;
  warnings: string[];
}

function utf8Bytes(value: string) {
  return new Blob([value]).size;
}

function normalizedMime(value: string) {
  const mime = String(value || "").trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

/**
 * Decode image data URLs without assuming that every payload is base64.
 * SVG data URLs commonly use percent-encoded XML instead.
 */
export function imageDataUrlToBlob(value: string): Blob | null {
  const match = String(value || "").match(/^data:([^;,]+)((?:;[^,]*)*),(.*)$/is);
  if (!match) return null;
  const mime = normalizedMime(match[1]);
  if (!IMAGE_MIMES.has(mime)) return null;
  const metadata = match[2] || "";
  const payload = match[3] || "";
  try {
    if (/(?:^|;)base64(?:;|$)/i.test(metadata)) {
      if (!/^[A-Za-z0-9+/=\s]*$/.test(payload)) return null;
      const binary = atob(payload.replace(/\s/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: mime });
    }
    if (mime !== "image/svg+xml") return null;
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch {
    return null;
  }
}

function removeUnsafeChildren(element: Element, warnings: string[]) {
  [...element.childNodes].forEach((child) => {
    if (child.nodeType === 8 || child.nodeType === 7) {
      child.parentNode?.removeChild(child);
      return;
    }
    if (child.nodeType !== 1) return;
    const childElement = child as Element;
    const tag = childElement.localName?.toLowerCase() || childElement.tagName.toLowerCase();
    if (!SAFE_ELEMENTS.has(tag)) {
      childElement.remove();
      warnings.push(`svg-tag-removed:${tag}`);
      return;
    }
    removeUnsafeChildren(childElement, warnings);
  });
}

function sanitizeAttributes(element: Element, warnings: string[]) {
  [...element.attributes].forEach((attribute) => {
    const name = attribute.name;
    const lowerName = name.toLowerCase();
    const value = attribute.value.trim();
    const allowed = SAFE_ATTRIBUTES.has(lowerName);
    const unsafeName = lowerName.startsWith("on") || lowerName === "style" || lowerName === "href" || lowerName.endsWith(":href");
    if (!allowed || unsafeName || DANGEROUS_VALUE.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      element.removeAttribute(name);
      warnings.push(`svg-attribute-removed:${lowerName}`);
      return;
    }
    if (lowerName === "id" && !SAFE_ID.test(value)) {
      element.removeAttribute(name);
      warnings.push("svg-invalid-id");
      return;
    }
    if (REFERENCE_ATTRIBUTES.has(lowerName) && /url\s*\(/i.test(value)) {
      const targets = [...value.matchAll(URL_REFERENCE)].map((match) => String(match[2] || "").trim());
      const unsafe = !targets.length || targets.some((target) => !LOCAL_FRAGMENT.test(target));
      if (unsafe) {
        element.removeAttribute(name);
        warnings.push(`svg-external-reference:${lowerName}`);
      }
    }
  });
}

/**
 * 第二輪才檢查 `url(#id)` 的目標存不存在：屬性清理是第一輪，
 * 被移除的 `<filter>`／`<mask>` 會讓參考變成悬空指針，渲染時整塊變黑。
 */
function dropDanglingReferences(root: Element, warnings: string[]) {
  const ids = new Set<string>();
  root.querySelectorAll("[id]").forEach((element) => {
    const id = element.getAttribute("id");
    if (id) ids.add(id);
  });
  root.querySelectorAll("*").forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const lowerName = attribute.name.toLowerCase();
      if (!REFERENCE_ATTRIBUTES.has(lowerName) || !/url\s*\(/i.test(attribute.value)) return;
      const targets = [...attribute.value.matchAll(URL_REFERENCE)].map((match) => String(match[2] || "").trim());
      const dangling = targets.some((target) => !LOCAL_FRAGMENT.test(target) || !ids.has(target.slice(1)));
      if (dangling) {
        element.removeAttribute(attribute.name);
        warnings.push(`svg-dangling-reference:${lowerName}`);
      }
    });
  });
}

/**
 * 抽出 SVG 裡的文字。SVG 用 `<img>` 顯示時文字選不起來，
 * 放大檢視因此改成內嵌渲染並提供「複製其中文字」。
 */
export function svgTextContent(source: string) {
  const text = String(source || "");
  if (!text.trim() || typeof DOMParser === "undefined") return "";
  try {
    const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
    if (parsed.querySelector("parsererror")) return "";
    const parts: string[] = [];
    // `<text>` 的 textContent 已經包含巢狀 `<tspan>`，所以以 `<text>` 為單位；
    // 直接挂在 svg／g 底下的 tspan（不合法但看得到）才另外補上。
    parsed.querySelectorAll("text").forEach((element) => {
      const value = String(element.textContent || "").replace(/\s+/g, " ").trim();
      if (value) parts.push(value);
    });
    parsed.querySelectorAll("tspan").forEach((element) => {
      const parent = element.parentElement?.localName?.toLowerCase();
      if (parent === "text") return;
      const value = String(element.textContent || "").replace(/\s+/g, " ").trim();
      if (value) parts.push(value);
    });
    return parts.join("\n");
  } catch {
    return "";
  }
}

export function sanitizeSvg(source: string): SanitizedSvg | null {
  const text = String(source || "").replace(/^\uFEFF/, "");
  if (!text.trim() || utf8Bytes(text) > IMPORT_LIMITS.svgBytes) return null;
  if (/<\s*!doctype\b|<\s*!entity\b|<!\[cdata\[/i.test(text)) return null;
  const withoutXmlDeclaration = text.replace(/^\s*<\?xml\b[^?]*\?>\s*/i, "");
  if (/<\?(?!xml\b)[\s\S]*?\?>/i.test(withoutXmlDeclaration)) return null;
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") return null;

  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName?.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) return null;

  const warnings: string[] = [];
  let nodeCount = 0;
  let maxDepth = 0;
  const inspect = (node: Node, depth: number): boolean => {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (nodeCount > IMPORT_LIMITS.svgMaxNodes || maxDepth > IMPORT_LIMITS.svgMaxDepth) return false;
    if (node.nodeType === 1) {
      const element = node as Element;
      const tag = element.localName?.toLowerCase() || element.tagName.toLowerCase();
      if (!SAFE_ELEMENTS.has(tag)) {
        element.remove();
        warnings.push(`svg-tag-removed:${tag}`);
        return true;
      }
      sanitizeAttributes(element, warnings);
    } else if (node.nodeType !== 3) {
      node.parentNode?.removeChild(node);
      return true;
    }
    [...node.childNodes].forEach((child) => {
      if (!inspect(child, depth + 1)) throw new Error("svg-limit");
    });
    return true;
  };

  try {
    inspect(root, 1);
    removeUnsafeChildren(root, warnings);
  } catch {
    return null;
  }
  dropDanglingReferences(root, warnings);
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return { svg: new XMLSerializer().serializeToString(root), warnings };
}
