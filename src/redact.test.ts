import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

const s = (name: string, value: string) => ({ name, value });

describe("redactSecrets", () => {
  it("returns input unchanged when no secrets", () => {
    expect(redactSecrets("hello world", [])).toBe("hello world");
  });

  it("returns input unchanged when input is empty", () => {
    expect(redactSecrets("", [s("X", "secret")])).toBe("");
  });

  it("replaces a single occurrence", () => {
    expect(redactSecrets("token=sk-abc123", [s("TOK", "sk-abc123")])).toBe(
      "token=[REDACTED:TOK]"
    );
  });

  it("replaces multiple occurrences of the same secret", () => {
    expect(
      redactSecrets("a sk-abc123 b sk-abc123 c", [s("TOK", "sk-abc123")])
    ).toBe("a [REDACTED:TOK] b [REDACTED:TOK] c");
  });

  it("replaces values from multiple secrets independently", () => {
    expect(
      redactSecrets("k1=alpha k2=beta", [s("K1", "alpha"), s("K2", "beta")])
    ).toBe("k1=[REDACTED:K1] k2=[REDACTED:K2]");
  });

  it("skips secrets with values shorter than 4 chars", () => {
    expect(redactSecrets("foo abc bar", [s("X", "abc")])).toBe("foo abc bar");
  });

  it("skips secrets with empty values", () => {
    expect(redactSecrets("foo bar", [s("X", "")])).toBe("foo bar");
  });

  it("preserves the surrounding text exactly", () => {
    const text =
      "API call: GET /v1/users\nAuthorization: Bearer sk-test-1234567890\n";
    expect(redactSecrets(text, [s("KEY", "sk-test-1234567890")])).toBe(
      "API call: GET /v1/users\nAuthorization: Bearer [REDACTED:KEY]\n"
    );
  });
});
