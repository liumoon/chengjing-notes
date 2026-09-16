import { describe, expect, it } from 'vitest';
import { blockContains, markdownBlocks, previewOffsetToSource, renderMarkdownBlock } from './markdownLivePreview';
import type { AttachmentRecord } from '../types';

const NL = String.fromCharCode(10);

function attachment(id: string, name = id + '.png'): AttachmentRecord {
  return { id, name, mime: 'image/png', size: 5, storage: 'file', relativePath: 'files/' + name, createdAt: 1 };
}

describe('Markdown 即時預覽切塊', () => {
  it('以空行切塊，範圍連續無缺口', () => {
    const source = '# 標題' + NL + NL + '第一段' + NL + NL + '第二段';
    const blocks = markdownBlocks(source);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toBe('# 標題' + NL);
    expect(blocks[1].from).toBe(6);
    // 區塊範圍首尾相接，整份文件不會漏字。
    let covered = '';
    blocks.forEach((block) => { covered += source.slice(block.from, block.to); });
    expect(covered).toBe('# 標題' + NL + '第一段' + NL + '第二段');
  });

  it('圍欄程式碼裡的空行不切塊', () => {
    const source = '```js' + NL + 'const a = 1;' + NL + NL + 'const b = 2;' + NL + '```';
    const blocks = markdownBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(source);
  });

  it('游標落在區塊內（含邊界）時該區塊保持原始碼', () => {
    const [block] = markdownBlocks('# 標題' + NL + NL + '内文');
    expect(blockContains(block, 0, 0)).toBe(true);
    expect(blockContains(block, block.to, block.to)).toBe(true);
    expect(blockContains(block, block.to + 1, block.to + 1)).toBe(false);
  });
});

describe('Markdown 區塊渲染', () => {
  it('保留標題、清單、表格與連結等語意結構', () => {
    const { html } = renderMarkdownBlock('## 小標' + NL + NL + '- 一' + NL + '- 二' + NL + NL + '| a | b |' + NL + '| - | - |' + NL + '| 1 | 2 |' + NL + NL + '[連結](https://example.com)');
    expect(html).toContain('<h2>小標</h2>');
    expect(html).toContain('<li>一</li>');
    expect(html).toContain('<table');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('>連結</a>');
  });

  it('核取清單留得下 checkbox 與完成狀態', () => {
    const { html } = renderMarkdownBlock('- [x] 已讀' + NL + '- [ ] 未讀');
    expect(html).toContain('type="checkbox"');
    expect((html.match(/checked/g) || []).length).toBe(1);
  });

  it('網路圖片不直接載入，改成下載提示', () => {
    const { html, remoteImages } = renderMarkdownBlock('![追蹤像素](https://track.example.org/pixel.gif)');
    expect(remoteImages).toEqual(['https://track.example.org/pixel.gif']);
    expect(html).toContain('md-remote-chip');
    expect(html).not.toContain('<img src="https://track.example.org');
  });

  it('attachment:// 解析成本機 URL，附件不見時留占位', () => {
    const found = renderMarkdownBlock('![圖](attachment://a1)', [attachment('a1')]);
    expect(found.html).toContain('chengjing-attachment://local/files%2Fa1.png');
    const missing = renderMarkdownBlock('![圖](attachment://gone)', []);
    expect(missing.html).toContain('data-missing-attachment="gone"');
  });

  it('危險內容不會進到預覽', () => {
    const { html } = renderMarkdownBlock('<script>alert(1)</script>' + NL + NL + '<img src="x" onerror="alert(2)">' + NL + NL + '[oops](javascript:alert(3))');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('中文與 CJK 檔名的圖片照樣解析', () => {
    const { html } = renderMarkdownBlock('![示意圖](attachment://cjk)', [attachment('cjk', '约翰三書 3-16.png')]);
    expect(html).toContain('chengjing-attachment://local');
    expect(html).toContain('alt="示意圖"');
  });
});

describe('預覽點擊回推原始碼位置', () => {
  it('跳過 Markdown 標記，只數看得到的字', () => {
    expect(previewOffsetToSource('**粗體**文字', 0)).toBe(2);
    expect(previewOffsetToSource('**粗體**文字', 2)).toBe(6);
    expect(previewOffsetToSource('# 標題', 0)).toBe(2);
    expect(previewOffsetToSource('- 項目', 0)).toBe(2);
    expect(previewOffsetToSource('[連結](https://example.com)', 1)).toBe(2);
    expect(previewOffsetToSource('一般', 99)).toBe(2);
  });
});
