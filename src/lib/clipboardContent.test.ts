import { describe, expect, it } from "vitest";
import { claimClipboardPaste, classifyClipboardPaste, embedClipboardImagesInHtml } from './clipboardContent';
import type { AttachmentRecord } from '../types';

interface ItemLike {
  kind: string;
  type: string;
  getAsFile: () => Blob | null;
}

function imageBlob(content = 'png!!') {
  return new Blob([content], { type: 'image/png' });
}

function pasteEvent(init: { text?: string; html?: string; images?: Blob[]; files?: File[] }) {
  const items: ItemLike[] = [];
  (init.images || []).forEach((blob) => items.push({ kind: 'file', type: blob.type, getAsFile: () => blob }));
  (init.files || []).forEach((file) => items.push({ kind: 'file', type: file.type, getAsFile: () => file }));
  const data = {
    items,
    files: [...(init.files || [])],
    getData: (type: string) => (type === 'text/plain' ? init.text || '' : type === 'text/html' ? init.html || '' : ''),
  };
  return { clipboardData: data } as unknown as ClipboardEvent;
}

function attachment(id: string, name = id + '.png'): AttachmentRecord {
  return { id, name, mime: 'image/png', size: 5, storage: 'file', relativePath: 'files/' + name, createdAt: 1 };
}

describe('剪貼簿貼上分流', () => {
  it('純文字就只是文字，不會被當成圖片攔下來', () => {
    const content = classifyClipboardPaste(pasteEvent({ text: '經文 3:16' }));
    expect(content.kind).toBe('text');
    expect(content.images).toHaveLength(0);
    expect(content.text).toBe('經文 3:16');
  });

  it('只有圖片時是 media，文字＋圖片才是 mixed', () => {
    expect(classifyClipboardPaste(pasteEvent({ images: [imageBlob()] })).kind).toBe('media');
    expect(classifyClipboardPaste(pasteEvent({ text: '看這張', images: [imageBlob()] })).kind).toBe('mixed');
    expect(classifyClipboardPaste(pasteEvent({})).kind).toBe('empty');
  });

  it('Chromium 用兩個不同的 Blob 呈現同一張圖時只留一張', () => {
    const first = imageBlob();
    const second = imageBlob();
    expect(first).not.toBe(second);
    const content = classifyClipboardPaste(pasteEvent({ images: [first, second] }));
    expect(content.images).toHaveLength(1);
  });

  it('不一樣的圖片兩張都留', () => {
    const content = classifyClipboardPaste(pasteEvent({ images: [imageBlob('aaa'), imageBlob('bbbbbb')] }));
    expect(content.images).toHaveLength(2);
  });

  it('同一次 paste 事件只准被認領一次', () => {
    const event = pasteEvent({ images: [imageBlob()] });
    expect(claimClipboardPaste(event)).toBe(true);
    expect(claimClipboardPaste(event)).toBe(false);
  });

  it('格式化內容帶 HTML 時歸為 html，檔案則歸為 file', () => {
    expect(classifyClipboardPaste(pasteEvent({ text: 'x', html: '<p><strong>x</strong></p>' })).kind).toBe('html');
    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' }) as File & { path: string };
    file.path = '/tmp/report.pdf';
    const content = classifyClipboardPaste(pasteEvent({ text: 'x', files: [file] }));
    expect(content.kind).toBe('file');
    expect(content.files.map((item) => item.name)).toEqual(['report.pdf']);
  });
});

describe('混合貼上的圖片對應', () => {
  it('HTML 裡的 img 依序換成附件參考，多出來的附加在末尾', () => {
    const html = '<p><strong>標題</strong> 內文 <img src="blob:deadbeef"></p>';
    const result = embedClipboardImagesInHtml(html, [attachment('a1'), attachment('a2', 'second.png')]);
    expect(result.placed).toBe(1);
    expect(result.appended).toBe(1);
    expect(result.html).toContain('<strong>標題</strong>');
    expect(result.html).toContain('attachment://a1');
    expect(result.html).toContain('attachment://a2');
    expect(result.html).not.toContain('blob:');
  });

  it('沒有圖片時原封不動，不會憑空插入附件', () => {
    const result = embedClipboardImagesInHtml('<p>只有文字</p>', []);
    expect(result.html).toBe('<p>只有文字</p>');
    expect(result.placed).toBe(0);
  });
});
