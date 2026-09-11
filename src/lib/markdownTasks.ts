/**
 * Markdown ⇄ 富文字切換時的核取清單對账。
 *
 * TipTap 的核取清單以 `data-task-id` 綁定 `TaskRecord.sourceTaskId`，
 * 而 Markdown 的 `- [ ]` 語法沒有地方放這個 ID。若切換後重新鑄 ID，
 * 已同步的待辦會被當成「舊待辦消失、新待辦出現」，連帶遺失到期日、
 * 完成狀態與歷史。這裡改用「文字＋階層＋同層序號」比對，把舊 ID 貼回
 * 新的 HTML，讓 `normalizeEditorTaskHtml` 認為這些項目本來就有 ID。
 */

export interface TaskFingerprint {
  taskId: string;
  text: string;
  depth: number;
  ordinal: number;
  /** 從根開始的同層路徑，例如 "0/1/0"。 */
  path: string;
  checked: boolean;
}

function taskText(item: Element) {
  const content = item.querySelector(":scope > div") || item;
  const clone = content.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('ul[data-type="taskList"], ol[data-type="taskList"], label, input').forEach((element) => element.remove());
  return (clone.textContent || "").replace(/\s+/g, " ").trim();
}

function taskListDepth(item: Element) {
  let depth = 0;
  let parent = item.parentElement;
  while (parent) {
    if (parent.matches('ul[data-type="taskList"], ol[data-type="taskList"]')) depth += 1;
    parent = parent.parentElement;
  }
  return depth;
}

/** 依文件順序收集核取清單項目，並算出階層與同層序號。 */
export function fingerprintTasks(html: string): TaskFingerprint[] {
  const document = new DOMParser().parseFromString(html || "<p></p>", "text/html");
  const counters = new Map<number, number>();
  const fingerprints: TaskFingerprint[] = [];
  document.body.querySelectorAll('ul[data-type="taskList"] > li, li[data-type="taskItem"]').forEach((item) => {
    const depth = taskListDepth(item);
    const ordinal = counters.get(depth) || 0;
    counters.set(depth, ordinal + 1);
    // 清除更深層的計數器，因為新的同層項目會讓下層重新從 0 開始。
    for (const key of [...counters.keys()]) if (key > depth) counters.delete(key);
    const ancestors: number[] = [];
    let node: Element | null = item;
    while (node) {
      const parent: Element | null = node.parentElement;
      if (parent?.matches('ul[data-type="taskList"] > li, li[data-type="taskItem"]')) {
        ancestors.unshift([...parent.parentElement?.children || []].indexOf(parent));
        node = parent;
      } else if (parent?.matches('ul[data-type="taskList"], ol[data-type="taskList"]')) {
        ancestors.unshift([...parent.parentElement?.children || []].indexOf(parent));
        node = parent;
      } else node = null;
    }
    fingerprints.push({
      taskId: (item.getAttribute("data-task-id") || "").trim(),
      text: taskText(item),
      depth,
      ordinal,
      path: ancestors.join("/"),
      checked: item.getAttribute("data-checked") === "true",
    });
  });
  return fingerprints;
}

/**
 * 把 `previous` 的 `data-task-id` 貼回 `next`。
 * 比對順序：既有 ID → 文字＋路徑 → 文字＋階層＋序號 → 文字（依序）。
 */
export function reconcileTaskIds(nextHtml: string, previousHtml: string) {
  const previous = fingerprintTasks(previousHtml).filter((item) => item.taskId);
  if (!previous.length) return { html: nextHtml, reused: 0, created: 0 };
  const document = new DOMParser().parseFromString(nextHtml || "<p></p>", "text/html");
  const items = [...document.body.querySelectorAll('ul[data-type="taskList"] > li, li[data-type="taskItem"]')];
  const available = new Map<string, TaskFingerprint>();
  const consumed = new Set<string>();
  previous.forEach((item) => available.set(item.taskId, item));

  const take = (predicate: (candidate: TaskFingerprint) => boolean) => {
    for (const candidate of available.values()) {
      if (consumed.has(candidate.taskId)) continue;
      if (!predicate(candidate)) continue;
      consumed.add(candidate.taskId);
      return candidate.taskId;
    }
    return "";
  };

  let reused = 0;
  let created = 0;
  const assigned: Array<{ item: Element; fingerprint: TaskFingerprint | null }> = [];
  // 第一輪：保留 next 已經存在的 ID，避免重複使用。
  items.forEach((item) => {
    const existing = (item.getAttribute("data-task-id") || "").trim();
    if (existing && available.has(existing)) {
      consumed.add(existing);
      assigned.push({ item, fingerprint: available.get(existing)! });
      return;
    }
    assigned.push({ item, fingerprint: null });
  });
  // 第二輪：依序為沒有 ID 的項目比對。
  const counters = new Map<number, number>();
  assigned.forEach(({ item, fingerprint }) => {
    const depth = taskListDepth(item);
    const ordinal = counters.get(depth) || 0;
    counters.set(depth, ordinal + 1);
    for (const key of [...counters.keys()]) if (key > depth) counters.delete(key);
    if (fingerprint) return;
    const text = taskText(item);
    const path = ancestorsPath(item);
    const match = take((candidate) => Boolean(text) && candidate.text === text && candidate.path === path)
      || take((candidate) => Boolean(text) && candidate.text === text && candidate.depth === depth && candidate.ordinal === ordinal)
      || take((candidate) => Boolean(text) && candidate.text === text);
    if (match) {
      item.setAttribute("data-task-id", match);
      reused += 1;
    } else created += 1;
  });
  return { html: document.body.innerHTML || "<p></p>", reused, created };
}

function ancestorsPath(item: Element) {
  const ancestors: number[] = [];
  let node: Element | null = item;
  while (node) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    if (parent.matches('ul[data-type="taskList"], ol[data-type="taskList"]')) {
      const owner: Element | null = parent.parentElement;
      if (owner) ancestors.unshift([...owner.children].indexOf(parent));
      node = owner;
    } else node = parent;
  }
  return ancestors.join("/");
}
