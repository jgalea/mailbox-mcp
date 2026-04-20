import { describe, it, expect } from "vitest";
import { buildRawMimeMessage } from "../../src/providers/mime.js";

describe("buildRawMimeMessage subject encoding", () => {
  it("passes ASCII subjects through unchanged", () => {
    const raw = buildRawMimeMessage({
      to: ["a@example.com"],
      subject: "Hello world",
      body: "body",
    }).toString("utf-8");
    expect(raw).toContain("Subject: Hello world\r\n");
  });

  it("RFC 2047 encodes non-ASCII subjects so headers stay 7-bit clean", () => {
    const raw = buildRawMimeMessage({
      to: ["a@example.com"],
      subject: "Café — résumé update",
      body: "body",
    }).toString("utf-8");

    const match = raw.match(/^Subject: (.+)\r\n/m);
    expect(match).not.toBeNull();
    const headerValue = match![1];

    // The emitted header value must not contain raw non-ASCII bytes.
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7e]+$/.test(headerValue)).toBe(true);

    // And it must round-trip back to the original string via RFC 2047 decoding.
    const m = headerValue.match(/^=\?utf-8\?B\?([^?]+)\?=$/);
    expect(m).not.toBeNull();
    const decoded = Buffer.from(m![1], "base64").toString("utf-8");
    expect(decoded).toBe("Café — résumé update");
  });
});
