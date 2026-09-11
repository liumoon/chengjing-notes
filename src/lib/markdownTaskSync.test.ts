import { describe, expect, it } from "vitest";
import { fingerprintTasks, reconcileTaskIds } from "./markdownTasks";

/**
 * 核取清單對账：Markdown ⇄ 富文字切換時，用文字＋階層＋同層序號把舊的
 * `data-task-id` 貼回新 HTML，讓已同步待辦的完成狀態與到期日不被重建。
 */
function taskList(...items: Array<{ text: string; checked?: boolean; id?: string }>) {
  const body = items
    .map((item) => {
      const checked = item.checked ? ' data-checked="true"' : "";
      const id = item.id ? ` data-task-id="${item.id}"` : "";
      return `<li data-type="taskItem"${id}${checked}><div><p>${item.text}</p></div></li>`;
    })
    .join("");
  return `<ul data-type="taskList">${body}</ul>`;
}

describe("核取清單指纹", () => {
  it("依序收集文字、階層與序號", () => {
    const html = `<div><ul data-type="taskList"><li data-type="taskItem"><div><p>第一項</p></div></li></ul><ul data-type="taskList"><li data-type="taskItem"><div><p>第二項</p></div></li></ul></div>`;
    const fingerprints = fingerprintTasks(html);
    expect(fingerprints.map((item) => item.text)).toEqual(["第一項", "第二項"]);
    expect(fingerprints.every((item) => item.depth === 1)).toBe(true);
  });
});

describe("reconcileTaskIds 保留既有 ID", () => {
  it("文字相同時把舊 ID 貼回新項目，完成狀態不重建", () => {
    const previous = taskList({ text: "買牛奶", id: "task-1", checked: true });
    const next = taskList({ text: "買牛奶" });
    const result = reconcileTaskIds(next, previous);
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const item = document.querySelector('li[data-type="taskItem"]');
    expect(item?.getAttribute("data-task-id")).toBe("task-1");
    // 由於沿用同一 ID，已完成待辦的完成狀態與到期日不會被重建。
    expect(result.reused).toBe(1);
    expect(result.created).toBe(0);
  });

  it("重新排序後仍依文字比對，不依賴位置", () => {
    const previous = taskList({ text: "A", id: "id-a" }, { text: "B", id: "id-b" });
    const next = taskList({ text: "B" }, { text: "A" });
    const result = reconcileTaskIds(next, previous);
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const byText = Object.fromEntries([...document.querySelectorAll('li[data-type="taskItem"]')].map((item) => [item.textContent, item.getAttribute("data-task-id")]));
    expect(byText["B"]).toBe("id-b");
    expect(byText["A"]).toBe("id-a");
  });

  it("改名後建立新 ID，但不影響其他項目", () => {
    const previous = taskList({ text: "舊名稱", id: "keep" }, { text: "不變", id: "stable" });
    const next = taskList({ text: "新名稱" }, { text: "不變" });
    const result = reconcileTaskIds(next, previous);
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const items = [...document.querySelectorAll('li[data-type="taskItem"]')];
    // 未改名的項目沿用舊 ID。
    expect(items[1].getAttribute("data-task-id")).toBe("stable");
    // 改名的項目沒有可對應的舊 ID，建立新的。
    expect(items[0].getAttribute("data-task-id")).toBeNull();
    expect(result.created).toBe(1);
    expect(result.reused).toBe(1);
  });

  it("沒有舊 ID 時不產生任何對應", () => {
    const previous = taskList({ text: "無 ID" });
    const next = taskList({ text: "無 ID" });
    const result = reconcileTaskIds(next, previous);
    expect(result.reused).toBe(0);
    expect(result.created).toBe(0);
  });

  it("巢狀清單依階層與同層序號比對", () => {
    const previous = `<ul data-type="taskList"><li data-type="taskItem" data-task-id="top"><div><p>頂層</p></div><ul data-type="taskList"><li data-type="taskItem" data-task-id="child"><div><p>子項</p></div></li></ul></li></ul>`;
    const next = `<ul data-type="taskList"><li data-type="taskItem"><div><p>頂層</p></div><ul data-type="taskList"><li data-type="taskItem"><div><p>子項</p></div></li></ul></li></ul>`;
    const result = reconcileTaskIds(next, previous);
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const items = [...document.querySelectorAll('li[data-type="taskItem"]')];
    // 頂層與子層各自沿用 ID。
    expect(items.map((item) => item.getAttribute("data-task-id"))).toEqual(["top", "child"]);
  });
});
