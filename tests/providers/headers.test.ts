import { describe, it, expect } from "vitest";
import {
  ensureReplyPrefix,
  ensureForwardPrefix,
  splitAddressList,
} from "../../src/providers/headers.js";

describe("ensureReplyPrefix", () => {
  it("adds Re: when missing", () => {
    expect(ensureReplyPrefix("Hello")).toBe("Re: Hello");
  });
  it("keeps existing Re: prefix", () => {
    expect(ensureReplyPrefix("Re: Hello")).toBe("Re: Hello");
  });
  it("matches case-insensitively", () => {
    expect(ensureReplyPrefix("RE: hi")).toBe("RE: hi");
    expect(ensureReplyPrefix("re: hi")).toBe("re: hi");
  });
  it("ignores substrings that start with Re but aren't the prefix", () => {
    expect(ensureReplyPrefix("Are: the books ready?")).toBe("Re: Are: the books ready?");
    expect(ensureReplyPrefix("Report: status")).toBe("Re: Report: status");
  });
});

describe("ensureForwardPrefix", () => {
  it("adds Fwd: when missing", () => {
    expect(ensureForwardPrefix("Hello")).toBe("Fwd: Hello");
  });
  it("accepts Fwd: and Fw: variants", () => {
    expect(ensureForwardPrefix("Fwd: Hi")).toBe("Fwd: Hi");
    expect(ensureForwardPrefix("Fw: Hi")).toBe("Fw: Hi");
    expect(ensureForwardPrefix("FWD: Hi")).toBe("FWD: Hi");
  });
  it("doesn't trigger on unrelated Fw-starting words", () => {
    expect(ensureForwardPrefix("Fwoosh effect")).toBe("Fwd: Fwoosh effect");
  });
});

describe("splitAddressList", () => {
  it("splits plain comma-separated addresses", () => {
    expect(splitAddressList("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });
  it("preserves commas inside quoted display names", () => {
    expect(splitAddressList('"Smith, John" <john@x.com>, other@y.com')).toEqual([
      '"Smith, John" <john@x.com>',
      "other@y.com",
    ]);
  });
  it("preserves commas inside angle brackets", () => {
    // Not RFC-legal, but defensive — e.g. group display names or malformed addresses.
    expect(splitAddressList("<a,b@x.com>, c@y.com")).toEqual(["<a,b@x.com>", "c@y.com"]);
  });
  it("handles escaped quotes inside quoted strings", () => {
    expect(splitAddressList('"he said \\"hi\\"" <a@x.com>, b@y.com')).toEqual([
      '"he said \\"hi\\"" <a@x.com>',
      "b@y.com",
    ]);
  });
  it("returns empty array for empty input", () => {
    expect(splitAddressList("")).toEqual([]);
    expect(splitAddressList("   ")).toEqual([]);
  });
  it("trims surrounding whitespace", () => {
    expect(splitAddressList("  a@x.com  ,  b@y.com  ")).toEqual(["a@x.com", "b@y.com"]);
  });
});
