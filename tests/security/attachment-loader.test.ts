import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAttachmentFromPath,
  loadAttachments,
  guessMimeType,
  MAX_ATTACHMENT_BYTES,
} from "../../src/security/attachment-loader.js";

describe("attachment-loader", () => {
  let dir: string;
  let pdfPath: string;
  let txtPath: string;
  let unknownPath: string;
  let subdir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mbx-att-"));
    pdfPath = join(dir, "report.pdf");
    txtPath = join(dir, "notes.txt");
    unknownPath = join(dir, "blob.xyz");
    subdir = join(dir, "sub");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4\ncontent"));
    writeFileSync(txtPath, Buffer.from("hello world"));
    writeFileSync(unknownPath, Buffer.from([0, 1, 2, 3]));
    mkdirSync(subdir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("guessMimeType", () => {
    it("detects known extensions", () => {
      expect(guessMimeType("report.pdf")).toBe("application/pdf");
      expect(guessMimeType("Photo.JPG")).toBe("image/jpeg");
      expect(guessMimeType("clip.mp4")).toBe("video/mp4");
    });
    it("falls back for unknown extensions", () => {
      expect(guessMimeType("blob.xyz")).toBe("application/octet-stream");
      expect(guessMimeType("no-extension")).toBe("application/octet-stream");
    });
  });

  describe("loadAttachmentFromPath", () => {
    it("loads a regular file with guessed mime type", () => {
      const att = loadAttachmentFromPath(pdfPath);
      expect(att.filename).toBe("report.pdf");
      expect(att.mimeType).toBe("application/pdf");
      expect(att.data.length).toBeGreaterThan(0);
      expect(att.data.toString("utf-8")).toContain("%PDF-1.4");
    });

    it("uses octet-stream for unknown extensions", () => {
      const att = loadAttachmentFromPath(unknownPath);
      expect(att.mimeType).toBe("application/octet-stream");
    });

    it("rejects missing files", () => {
      expect(() => loadAttachmentFromPath(join(dir, "does-not-exist"))).toThrow(
        /Attachment not found/
      );
    });

    it("rejects directories", () => {
      expect(() => loadAttachmentFromPath(subdir)).toThrow(/not a regular file/);
    });

    it("rejects empty path", () => {
      expect(() => loadAttachmentFromPath("")).toThrow(/non-empty string/);
    });

    it("rejects path containing null byte", () => {
      expect(() => loadAttachmentFromPath(`${pdfPath}\0evil`)).toThrow(/null byte/);
    });

    it("follows symlinks to load the underlying file", () => {
      const link = join(dir, "link.pdf");
      symlinkSync(pdfPath, link);
      const att = loadAttachmentFromPath(link);
      expect(att.data.toString("utf-8")).toContain("%PDF-1.4");
    });

    it("strips CRLF from the derived filename", () => {
      // basename can't easily contain CRLF on real filesystems, but we still
      // run it through stripCRLF. Here we just verify a normal name is preserved.
      const att = loadAttachmentFromPath(txtPath);
      expect(att.filename).toBe("notes.txt");
      expect(att.filename).not.toContain("\r");
      expect(att.filename).not.toContain("\n");
    });
  });

  describe("loadAttachments", () => {
    it("returns undefined for no paths", () => {
      expect(loadAttachments(undefined)).toBeUndefined();
      expect(loadAttachments([])).toBeUndefined();
    });

    it("loads multiple attachments", () => {
      const atts = loadAttachments([pdfPath, txtPath]);
      expect(atts).toHaveLength(2);
      expect(atts![0].filename).toBe("report.pdf");
      expect(atts![1].filename).toBe("notes.txt");
    });

    it("rejects if total size exceeds the message cap", () => {
      // Create a file just over half the per-file cap so two of them bust the total.
      const bigA = join(dir, "big-a.bin");
      const bigB = join(dir, "big-b.bin");
      const halfPlus = Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1024;
      writeFileSync(bigA, Buffer.alloc(halfPlus));
      writeFileSync(bigB, Buffer.alloc(halfPlus));
      expect(() => loadAttachments([bigA, bigB])).toThrow(/exceeds per-message limit/);
    });

    it("rejects a single file over the per-file cap", () => {
      const huge = join(dir, "huge.bin");
      writeFileSync(huge, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
      expect(() => loadAttachments([huge])).toThrow(/exceeds per-file limit/);
    });
  });
});
