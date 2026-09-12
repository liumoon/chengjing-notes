import { describe, expect, it } from "vitest";
import { inspectBackup } from "./backupValidation";

function backup(overrides: Record<string, unknown> = {}) {
  return {
    format: "chengjing-backup",
    version: 2,
    data: {
      cards: [{ id: "card-1", title: "Test", contentHtml: "<p><img src=\"attachment://inline-1\" /></p>", plainText: "", kind: "note", state: "active", tagIds: [], attachmentIds: ["source-1", "inline-1"] }],
      boards: [{ id: "board-1" }],
      boardNodes: [{ id: "node-1" }],
      boardEdges: [],
      tags: [],
      tasks: [{ id: "task-1" }],
      attachments: [{ id: "source-1" }, { id: "inline-1" }],
      ...overrides,
    },
  };
}

describe("inspectBackup", () => {
  it("summarizes records and references without changing the backup", () => {
    expect(inspectBackup(backup())).toMatchObject({
      version: 2,
      cardCount: 1,
      attachmentCount: 2,
      taskCount: 1,
      boardCount: 1,
      boardNodeCount: 1,
      attachmentReferenceCount: 2,
      missingAttachmentIds: [],
      restorable: true,
    });
  });

  it("reports missing attachment references as a warning", () => {
    const result = inspectBackup(backup({ attachments: [] }));
    expect(result.missingAttachmentIds).toEqual(["inline-1", "source-1"]);
    expect(result.warningCodes).toEqual(["missing-attachment"]);
    expect(result.restorable).toBe(true);
  });
});
