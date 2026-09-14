import { describe, expect, it } from "vitest";
import { appendContent, fromHtml, fromMarkdown, fromPlainText, plainTextFromHtml, toMarkdown } from "./contentPipeline";

/**
 * CommonMark / GFM 往返與富文字⇄Markdown 雙模式語意保真。
 *
 * 規格要求：標題、粗斜體、連結、引用、巢狀清單、核取清單、程式碼、表格、
 * 刪除線、中文與 CJK 檔名都要保留；富文字與 Markdown 反覆切換不改變語意。
 */
describe("Markdown 雙模式語意保真", () => {
  it("保留層級標題", async () => {
    const chunk = await fromMarkdown("# 一層\n\n## 兩層\n\n### 三層\n");
    expect(chunk.contentHtml).toContain("<h1>一層</h1>");
    expect(chunk.contentHtml).toContain("<h2>兩層</h2>");
    expect(chunk.contentHtml).toContain("<h3>三層</h3>");
  });

  it("保留粗體、斜體與刪除線", async () => {
    const chunk = await fromMarkdown("**粗體** *斜體* ~~刪除線~~");
    expect(chunk.contentHtml).toContain("<strong>粗體</strong>");
    expect(chunk.contentHtml).toContain("<em>斜體</em>");
    // TipTap 刪除線以 <s> 或 <del> 輸出，兩者都接受。
    expect(chunk.contentHtml).toMatch(/<(del|s)>刪除線/);
  });

  it("保留連結並開啟新分頁", async () => {
    const chunk = await fromMarkdown("[文字](https://example.com)");
    expect(chunk.contentHtml).toContain('href="https://example.com"');
    expect(chunk.contentHtml).toContain('target="_blank"');
    expect(chunk.contentHtml).toContain('rel="noopener noreferrer"');
  });

  it("保留引用區塊", async () => {
    const chunk = await fromMarkdown("> 引用第一行\n> 引用第二行");
    expect(chunk.contentHtml).toContain("<blockquote>");
    expect(chunk.plainText).toContain("引用第一行");
  });

  it("保留巢狀清單階層", async () => {
    const chunk = await fromMarkdown("- 頂層\n  - 第一層嵌套");
    expect(chunk.contentHtml).toContain("<ul>");
    const document = new DOMParser().parseFromString(chunk.contentHtml, "text/html");
    expect(document.querySelectorAll("ul ul").length).toBeGreaterThanOrEqual(1);
    expect(document.querySelectorAll("ul ul ul").length).toBe(0);
  });

  it("保留核取清單的完成狀態", async () => {
    const chunk = await fromMarkdown("- [ ] 未完成\n- [x] 已完成");
    expect(chunk.contentHtml).toContain('data-type="taskList"');
    const document = new DOMParser().parseFromString(chunk.contentHtml, "text/html");
    const items = [...document.querySelectorAll('li[data-type="taskItem"]')];
    expect(items[0].getAttribute("data-checked")).toBe("false");
    expect(items[1].getAttribute("data-checked")).toBe("true");
  });

  it("保留程式碼區塊", async () => {
    const chunk = await fromMarkdown("```js\nconst answer = 42;\n```");
    expect(chunk.contentHtml).toContain("<pre><code>");
    expect(chunk.contentHtml).toContain("const answer = 42;");
  });

  it("保留 GFM 表格結構", async () => {
    const chunk = await fromMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const document = new DOMParser().parseFromString(chunk.contentHtml, "text/html");
    expect(document.querySelectorAll("table").length).toBe(1);
    expect(document.querySelectorAll("table tr").length).toBe(2);
    expect(document.querySelectorAll("table td").length).toBe(2);
  });

  it("中文與 CJK 文字匯入後仍保留完整", async () => {
    const chunk = await fromMarkdown("# 會議結論\n\n這是中文與日本語と한국어의 텍스트입니다.");
    expect(chunk.plainText).toContain("會議結論");
    expect(chunk.plainText).toContain("日本語");
    expect(chunk.plainText).toContain("한국어");
  });

  it("空 Markdown 產生空段落，不崩潰", async () => {
    const chunk = await fromMarkdown("   \n  \n");
    expect(chunk.contentHtml).toBe("<p></p>");
    expect(chunk.plainText).toBe("");
  });

  it("純文字不把清單字面誤解成清單，並轉義危險字元", async () => {
    const chunk = fromPlainText("- 这不是清单\n\n第二段文字\n\n含有 <b> 符號");
    expect(chunk.contentHtml).not.toContain("<ul>");
    expect(chunk.contentHtml).toContain("&lt;b&gt;");
    expect(chunk.plainText).toContain("- 这不是清单");
  });
});

describe("富文字 ⇄ Markdown 反覆切換不改變語意", () => {
  const source = "# 標題\n\n**粗體** 和 [連結](https://ex.com)。\n\n- [ ] 待辦\n- [x] 完成\n\n> 引用\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";

  it("Markdown → HTML → Markdown 回到相同語意", async () => {
    const first = await fromMarkdown(source);
    const back = await toMarkdown(first.contentHtml);
    const second = await fromMarkdown(back.markdown);
    // 兩次 HTML 的純文字投影應一致（語意保真，非位元級）。
    expect(plainTextFromHtml(second.contentHtml)).toBe(plainTextFromHtml(first.contentHtml));
    // 核取清單完成狀態保持一致。
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
    const firstDone = parse(first.contentHtml).querySelectorAll('li[data-checked="true"]').length;
    const secondDone = parse(second.contentHtml).querySelectorAll('li[data-checked="true"]').length;
    expect(secondDone).toBe(firstDone);
  });

  it("連續三次往返語意不變", async () => {
    let html = (await fromMarkdown(source)).contentHtml;
    const baseline = plainTextFromHtml(html);
    for (let round = 0; round < 3; round += 1) {
      const markdown = await toMarkdown(html);
      const next = await fromMarkdown(markdown.markdown);
      html = next.contentHtml;
    }
    expect(plainTextFromHtml(html)).toBe(baseline);
  });

  it("Markdown 編輯日誌時沿用既有核取清單 ID", async () => {
    const previousHtml = '<ul data-type="taskList"><li data-type="taskItem" data-task-id="journal-task-1" data-checked="true"><div><p>回覆郵件</p></div></li></ul>';
    const next = await fromMarkdown("- [x] 回覆郵件\n", { previousHtml });
    const document = new DOMParser().parseFromString(next.contentHtml, "text/html");
    const task = document.querySelector('li[data-type="taskItem"]');

    expect(task?.getAttribute("data-task-id")).toBe("journal-task-1");
    expect(task?.getAttribute("data-checked")).toBe("true");
  });
});

describe("appendContent 附加與核取清單 ID", () => {
  it("把新內容接到卡片尾部", async () => {
    const head = await fromMarkdown("# A\n");
    const merged = await appendContent(head, { markdown: "- x\n" });
    expect(merged.contentHtml).toContain("<h1>A</h1>");
    expect(merged.contentHtml).toContain("<li>");
  });

  it("沒有新內容時維持原卡片", async () => {
    const head = await fromMarkdown("# A\n");
    const merged = await appendContent(head, { contentHtml: "" });
    expect(merged.contentHtml).toBe(head.contentHtml);
  });

  it("從 HTML 來源附加也保留結構", async () => {
    const head = await fromPlainText("開頭");
    const merged = await appendContent(head, { contentHtml: "<h2>第二段</h2><p>文字</p>" });
    expect(merged.contentHtml).toContain("<h2>第二段</h2>");
    expect(merged.plainText).toContain("開頭");
  });
});
