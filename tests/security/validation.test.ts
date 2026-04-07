import { describe, it, expect } from "vitest";
import {
  isPrivateIP,
  validateNoSSRF,
  stripCRLF,
  validateAttachmentPath,
} from "../../src/security/validation.js";

describe("SSRF prevention", () => {
  it("blocks private IPv4 addresses", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("192.168.1.1")).toBe(true);
    expect(isPrivateIP("172.16.0.1")).toBe(true);
  });

  it("blocks IPv6 loopback", () => {
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("0:0:0:0:0:0:0:1")).toBe(true);
  });

  it("blocks cloud metadata endpoints", () => {
    expect(isPrivateIP("169.254.169.254")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("142.250.80.46")).toBe(false);
  });

  it("validateNoSSRF throws on private URLs", () => {
    expect(() => validateNoSSRF("http://127.0.0.1/secret")).toThrow("blocked");
    expect(() => validateNoSSRF("http://169.254.169.254/metadata")).toThrow("blocked");
  });

  it("validateNoSSRF allows public URLs", () => {
    expect(() => validateNoSSRF("https://example.com")).not.toThrow();
  });
});

describe("CRLF injection prevention", () => {
  it("strips carriage return and newline from headers", () => {
    expect(stripCRLF("Subject: Test\r\nBcc: evil@attacker.com")).toBe(
      "Subject: TestBcc: evil@attacker.com"
    );
  });

  it("leaves clean strings unchanged", () => {
    expect(stripCRLF("Hello World")).toBe("Hello World");
  });
});

describe("attachment path validation", () => {
  it("blocks path traversal", () => {
    expect(() => validateAttachmentPath("../../etc/passwd")).toThrow();
    expect(() => validateAttachmentPath("/etc/passwd")).toThrow();
  });

  it("allows simple filenames", () => {
    expect(() => validateAttachmentPath("invoice.pdf")).not.toThrow();
    expect(() => validateAttachmentPath("report 2026.xlsx")).not.toThrow();
  });
});
