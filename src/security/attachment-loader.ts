import { readFileSync, statSync, realpathSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type { Attachment } from "../providers/interface.js";
import { stripCRLF } from "./validation.js";

/** Gmail and most SMTP servers cap messages around 25 MB (pre base64). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Hard cap on total attachment payload per message. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ics: "text/calendar",
};

export function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Load an attachment from a local filesystem path for inclusion in an
 * outgoing email. Paths must point to an existing regular file; symlinks
 * are resolved before size checks; binary data is read into memory.
 *
 * The CRLF-free filename placed in the returned Attachment is derived from
 * basename(path) so the caller never controls header fields directly.
 */
export function loadAttachmentFromPath(path: string): Attachment {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Attachment path must be a non-empty string");
  }
  if (path.includes("\0")) {
    throw new Error("Attachment path contains null byte");
  }
  if (!existsSync(path)) {
    throw new Error(`Attachment not found: ${path}`);
  }
  const resolved = realpathSync(path);
  const stats = statSync(resolved);
  if (!stats.isFile()) {
    throw new Error(`Attachment is not a regular file: ${path}`);
  }
  if (stats.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment "${path}" is ${stats.size} bytes, exceeds per-file limit of ${MAX_ATTACHMENT_BYTES} bytes`
    );
  }
  const data = readFileSync(resolved);
  const filename = stripCRLF(basename(resolved));
  return {
    filename,
    mimeType: guessMimeType(filename),
    data,
  };
}

/** Load an array of attachment paths, enforcing an overall size cap. */
export function loadAttachments(paths: string[] | undefined): Attachment[] | undefined {
  if (!paths || paths.length === 0) return undefined;
  const loaded = paths.map(loadAttachmentFromPath);
  const total = loaded.reduce((sum, a) => sum + a.data.length, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `Total attachment size ${total} bytes exceeds per-message limit of ${MAX_TOTAL_ATTACHMENT_BYTES} bytes`
    );
  }
  return loaded;
}
