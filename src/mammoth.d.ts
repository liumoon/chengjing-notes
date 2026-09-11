declare module "mammoth/mammoth.browser" {
  export interface MammothMessage {
    type: string;
    message?: string;
  }
  export interface MammothImage {
    contentType: string;
    read: (encoding?: string) => Promise<string>;
    altText?: string;
    altTextRel?: string;
  }
  export interface MammothImageResult {
    src: string;
    alt?: string;
    title?: string;
    [attribute: string]: unknown;
  }
  export interface MammothOptions {
    styleMap?: string[];
    htmlPath?: string;
    includeDefaultStyleMap?: boolean;
    convertImage?: unknown;
    ignoreEmptyParagraphs?: boolean;
    idPrefix?: string;
    transformDocument?: (element: unknown) => unknown;
  }
  const mammoth: {
    convertToHtml: (input: { arrayBuffer: ArrayBuffer } | { path: string }, options?: MammothOptions) => Promise<{ value: string; messages: MammothMessage[] }>;
    extractRawText: (input: { arrayBuffer: ArrayBuffer } | { path: string }, options?: MammothOptions) => Promise<{ value: string; messages: MammothMessage[] }>;
    images: {
      imgElement: (handler: (image: MammothImage) => Promise<MammothImageResult> | MammothImageResult) => unknown;
      inlineImage: (handler: (image: MammothImage) => Promise<MammothImageResult> | MammothImageResult) => unknown;
    };
    convertImageToHtml?: unknown;
  };
  export default mammoth;
}
