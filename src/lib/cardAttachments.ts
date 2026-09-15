import { appendCardAttachmentsWithHistory } from "../db";
import type { AttachmentRecord } from "../types";
import { dataUrlToBlob } from "./utils";
import { removeStoredAttachment } from "./attachments";
import { storeAttachment } from "./importers";

/**
 * A file returned by the native picker or the browser fallback.
 * Native pickers may return only a path when metadataOnly is enabled.
 */
export interface SelectedAttachmentInput {
  name: string;
  path?: string;
  data?: string;
  blob?: Blob;
}

export interface AttachmentStoreFailure {
  name: string;
  error: unknown;
}

export function selectedAttachmentBlob(input: SelectedAttachmentInput) {
  if (input.blob) return input.blob;
  if (input.data) return dataUrlToBlob(`data:application/octet-stream;base64,${input.data}`);
  return new Blob([], { type: "application/octet-stream" });
}

/**
 * Store each selected file independently so one bad file does not discard
 * files that were already added successfully.
 */
export async function storeSelectedAttachments(inputs: SelectedAttachmentInput[]) {
  const attachments: AttachmentRecord[] = [];
  const failures: AttachmentStoreFailure[] = [];

  for (const input of inputs) {
    try {
      const attachment = await storeAttachment(input.name, selectedAttachmentBlob(input), input.path || undefined);
      attachments.push(attachment);
    } catch (error) {
      failures.push({ name: input.name, error });
    }
  }

  return { attachments, failures };
}

/**
 * Register stored attachments on a card atomically. If the card update fails,
 * remove the newly stored files so the picker cannot create orphan assets.
 */
export async function addSelectedAttachmentsToCard(cardId: string, inputs: SelectedAttachmentInput[]) {
  const result = await storeSelectedAttachments(inputs);
  if (!result.attachments.length) return result;

  try {
    const updated = await appendCardAttachmentsWithHistory(cardId, result.attachments.map((attachment) => attachment.id));
    if (!updated) throw new Error("card-not-found");
    return result;
  } catch (error) {
    await Promise.all(result.attachments.map((attachment) => removeStoredAttachment(attachment).catch(() => {})));
    throw error;
  }
}
