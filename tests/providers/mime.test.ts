import { describe, it, expect } from "vitest";
import { buildRawMimeMessage, encodeAddressList } from "../../src/providers/mime.js";

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

describe("encodeAddressList", () => {
  it("leaves a plain ASCII display name alone", () => {
    expect(encodeAddressList("Jean Galea <jean@example.com>")).toBe("Jean Galea <jean@example.com>");
  });

  it("encodes an accented display name as an RFC 2047 word", () => {
    const out = encodeAddressList("Administración LANTANA <admin@example.com>");
    expect(out).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <admin@example\.com>$/);
    const b64 = out.slice(out.indexOf("?B?") + 3, out.indexOf("?="));
    expect(Buffer.from(b64, "base64").toString("utf-8")).toBe("Administración LANTANA");
  });

  it("leaves a bare address untouched", () => {
    expect(encodeAddressList("admin@example.com")).toBe("admin@example.com");
  });

  it("keeps each address when several are present", () => {
    const out = encodeAddressList("Ana Pérez <a@x.com>, Bob <b@y.com>, c@z.com");
    expect(out.split(", ")).toHaveLength(3);
    expect(out).toContain("<a@x.com>");
    expect(out).toContain("Bob <b@y.com>");
    expect(out).toContain("c@z.com");
  });

  it("encodes a name containing a comma rather than splitting the address", () => {
    const out = encodeAddressList('"Galea, Jean" <jean@example.com>');
    expect(out).toContain("<jean@example.com>");
    expect(out.split("<")).toHaveLength(2);
  });

  it("does not double-encode a name that is already an encoded-word", () => {
    const already = "=?utf-8?B?QWRtaW5pc3RyYWNpw7Nu?= <admin@example.com>";
    expect(encodeAddressList(already)).toBe(already);
  });

  it("drops an empty display name cleanly", () => {
    expect(encodeAddressList("<admin@example.com>")).toBe("<admin@example.com>");
  });
});

describe("buildRawMimeMessage address headers", () => {
  it("emits a 7-bit clean To header when a recipient name is accented", () => {
    const raw = buildRawMimeMessage({
      to: ['"Administración LANTANA PREMIUM" <admin@example.com>'],
      subject: "Hola",
      body: "cuerpo",
    } as Parameters<typeof buildRawMimeMessage>[0]).toString("utf-8");
    const toLine = raw.split("\r\n").find((l) => l.startsWith("To: "))!;
    expect(toLine).toBeDefined();
    // The whole header must be 7-bit; raw UTF-8 here is what relays mangle.
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f]*$/.test(toLine)).toBe(true);
    expect(toLine).toContain("<admin@example.com>");
    expect(toLine).toContain("=?utf-8?B?");
  });
});
