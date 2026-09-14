import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentHealthPanel } from "./AttachmentHealthPanel";
import { inspectAttachmentHealth } from "../lib/attachmentHealth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../hooks/useI18n", () => ({
  useI18n: () => ({ language: "en" }),
}));

vi.mock("../lib/attachmentHealth", () => ({
  cleanOrphanAttachments: vi.fn(),
  inspectAttachmentHealth: vi.fn(),
}));

vi.mock("../lib/attachmentRefs", () => ({
  attachmentRef: (id: string) => `attachment://${id}`,
}));

vi.mock("../lib/attachments", () => ({
  attachmentUrl: (attachment: { id: string; blob?: Blob }) => attachment.blob ? `blob:preview-${attachment.id}` : "",
  portableAttachmentBlob: async (attachment: { blob?: Blob }) => attachment.blob || new Blob(),
  shouldRevokeAttachmentUrl: () => false,
}));

const inspectMock = vi.mocked(inspectAttachmentHealth);

function makeReport() {
  const image = new Blob(["image"], { type: "image/png" });
  return {
    checkedAt: Date.now(),
    total: 4,
    referenced: 3,
    orphaned: 1,
    issueCount: 1,
    bytes: 1024,
    entries: [
      {
        attachment: {
          id: "source-1",
          name: "notes.md",
          mime: "text/markdown",
          size: 128,
          storage: "file" as const,
          relativePath: "sources/notes.md",
          createdAt: Date.now(),
          role: "source" as const,
        },
        references: 1,
        referenceKinds: ["card:1"],
        issues: [],
      },
      {
        attachment: {
          id: "inline-1",
          name: "screenshot.png",
          mime: "image/png",
          size: image.size,
          blob: image,
          storage: "indexeddb" as const,
          createdAt: Date.now(),
          role: "inline" as const,
        },
        references: 2,
        referenceKinds: ["card:1", "content:1"],
        issues: [],
      },
      {
        attachment: {
          id: "orphan-1",
          name: "archive.pdf",
          mime: "application/pdf",
          size: 768,
          blob: new Blob(["pdf"], { type: "application/pdf" }),
          storage: "indexeddb" as const,
          createdAt: Date.now(),
          role: "attachment" as const,
        },
        references: 0,
        referenceKinds: [],
        issues: ["orphan" as const],
      },
      {
        attachment: {
          id: "file-1",
          name: "project.txt",
          mime: "text/plain",
          size: 64,
          storage: "file" as const,
          relativePath: "documents/project.txt",
          createdAt: Date.now(),
          role: "attachment" as const,
        },
        references: 1,
        referenceKinds: ["card:2"],
        issues: [],
      },
    ],
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  inspectMock.mockResolvedValue(makeReport());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AttachmentHealthPanel />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  delete window.chengjing;
});

describe("AttachmentHealthPanel", () => {
  it("lists healthy and orphaned attachments and filters by role", async () => {
    expect(container.querySelectorAll(".attachment-health-list > li")).toHaveLength(4);
    expect(container.textContent).toContain("notes.md");
    expect(container.textContent).toContain("screenshot.png");
    expect(container.textContent).toContain("archive.pdf");

    const inlineFilter = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((button) => button.textContent === "Inline images");
    expect(inlineFilter).toBeDefined();
    await act(async () => inlineFilter!.click());

    expect(container.querySelectorAll(".attachment-health-list > li")).toHaveLength(1);
    expect(container.textContent).toContain("screenshot.png");
    expect(container.textContent).not.toContain("archive.pdf");
  });

  it("searches attachment metadata and exposes details", async () => {
    const search = container.querySelector<HTMLInputElement>(".attachment-health-search input");
    expect(search).toBeTruthy();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "documents/project");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.querySelectorAll(".attachment-health-list > li")).toHaveLength(1);
    expect(container.textContent).toContain("project.txt");

    const detailsButton = container.querySelector<HTMLButtonElement>("[aria-label=Details]");
    expect(detailsButton).toBeTruthy();
    await act(async () => detailsButton!.click());
    expect(container.textContent).toContain("file-1");
    expect(container.textContent).toContain("documents/project.txt");
  });

  it("copies a stable attachment reference through the desktop bridge", async () => {
    const write = vi.fn(async () => {});
    window.chengjing = { clipboard: { write } } as unknown as NonNullable<Window["chengjing"]>;

    const copyButton = container.querySelector<HTMLButtonElement>("[aria-label='Copy attachment reference']");
    expect(copyButton).toBeTruthy();
    await act(async () => copyButton!.click());

    expect(write).toHaveBeenCalledWith({
      text: "attachment://source-1",
      payload: { kind: "attachment-ref", attachmentId: "source-1" },
    });
    expect(container.textContent).toContain("Attachment reference copied.");
  });
});
