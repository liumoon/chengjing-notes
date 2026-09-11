import { describe, expect, it } from "vitest";
import { getImportCopy, importCopyKeys, importWarningCopy } from "./importCopy";
import type { AppLanguage } from "../types";

/**
 * 五語文案完整性（規格：繁中、簡中、英文、日文、韓文）。
 *
 * 同一個狀態在桌面與 Android 顯示同一句話：所有 ImportCopy 鍵在五種語言
 * 都要有值，插值佔位符（{name} 等）也要齊全，否則執行期會出現半截句子。
 */
const languages: AppLanguage[] = ["zh-TW", "zh-CN", "en", "ja", "ko"];

describe("匯入與 Markdown 雙模式五語文案", () => {
  it("每種語言都齊全且為非空字串", () => {
    for (const language of languages) {
      const copy = getImportCopy(language);
      for (const key of importCopyKeys) {
        expect(typeof copy[key], `${language}.${key}`).toBe("string");
        expect(copy[key], `${language}.${key} 缺文案`).toBeTruthy();
      }
    }
  });

  it("佔位符變數與繁中基準一致", () => {
    const tokens = (value: string) => [...value.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).sort();
    const reference = getImportCopy("zh-TW");
    for (const language of languages) {
      const copy = getImportCopy(language);
      for (const key of importCopyKeys) {
        expect(tokens(copy[key]), `${language}.${key}`).toEqual(tokens(reference[key]));
      }
    }
  });

  it("警告與錯誤代碼在五語都翻譯成在地文案", () => {
    const codes = ["no-text", "truncated", "too-large", "blocked-html", "remote-images-blocked", "image-too-large", "image-rejected", "asset-missing", "path-traversal", "unsupported", "markdown-engine-fallback", "mammoth:style not found", "tasks-recreated:3"];
    for (const language of languages) {
      for (const code of codes) {
        expect(importWarningCopy(language, code), `${language}.${code}`).not.toBe(code);
      }
      expect(importWarningCopy(language, "tasks-recreated:3")).toContain("3");
      expect(importWarningCopy(language, "mammoth:style not found")).toContain("style not found");
    }
  });

  it("未知代碼退回原文，不拋錯", () => {
    for (const language of languages) {
      expect(importWarningCopy(language, "some-unknown-code")).toBe("some-unknown-code");
    }
  });
});
