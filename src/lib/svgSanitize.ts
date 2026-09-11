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
]);

const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const DANGEROUS_VALUE = /(?:javascript\s*:|vbscript\s*:|data\s*:|blob\s*:|file\s*:|https?:\/\/|url\s*\(|@import|<|>)/i;

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
    }
  });
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
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return { svg: new XMLSerializer().serializeToString(root), warnings };
}
