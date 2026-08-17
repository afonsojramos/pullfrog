import { describe, expect, it } from "vitest";
import { detectCodexRefresh } from "./codexRefreshDetect.ts";

// installCodexAuth touches the filesystem (mkdir + writeFile) — leaving it
// untested here per AGENTS.md guidance ("be highly dubious of any test that
// relies on mocks"). The conversion math is what we actually want to
// protect; the disk write is one writeFileSync call.

describe("detectCodexRefresh", () => {
  const original = "rt_original_chain";

  it("returns Codex-shape JSON when openai.refresh advanced", () => {
    const authFileContent = JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "rt_new_chain",
        access: "at_new",
        expires: 9_999_999_999_999,
        accountId: "acc_123",
      },
    });
    const result = detectCodexRefresh({ authFileContent, originalRefresh: original });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result ?? "{}");
    expect(parsed.auth_mode).toBe("chatgpt");
    expect(parsed.tokens.refresh_token).toBe("rt_new_chain");
    expect(parsed.tokens.access_token).toBe("at_new");
    expect(parsed.tokens.account_id).toBe("acc_123");
    expect(typeof parsed.last_refresh).toBe("string");
  });

  // the codex harness writes the CLI's own auth.json, so the rotated file comes
  // back in the storage shape rather than OpenCode's. covered here because the
  // failure is silent: a shape this function doesn't recognize reads as "no
  // rotation happened", and the rotated chain is dropped on the floor.
  it("reads the native Codex shape the codex harness writes", () => {
    const authFileContent = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id_native",
        access_token: "at_new",
        refresh_token: "rt_new_chain",
        account_id: "acc_123",
      },
    });
    const result = detectCodexRefresh({ authFileContent, originalRefresh: original });
    const parsed = JSON.parse(result ?? "{}");
    expect(parsed.tokens.refresh_token).toBe("rt_new_chain");
    expect(parsed.tokens.id_token).toBe("id_native");
    expect(parsed.tokens.account_id).toBe("acc_123");
  });

  // OpenCode's auth file has no slot for id_token, so without re-attaching the
  // pre-run value the write-back silently strips it — and the Codex CLI REFUSES
  // an auth.json with no `tokens.id_token`, which disqualifies the account from
  // the codex harness permanently. see wiki/codex-agent.md.
  it("re-attaches the pre-run id_token the OpenCode shape cannot carry", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "oauth", refresh: "rt_new_chain", access: "at_new", expires: 0 },
    });
    const result = detectCodexRefresh({
      authFileContent,
      originalRefresh: original,
      originalIdToken: "id_from_before_the_run",
    });
    expect(JSON.parse(result ?? "{}").tokens.id_token).toBe("id_from_before_the_run");
  });

  it("omits id_token entirely when neither the file nor the caller has one", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "oauth", refresh: "rt_new_chain", access: "at_new", expires: 0 },
    });
    const parsed = JSON.parse(
      detectCodexRefresh({ authFileContent, originalRefresh: original }) ?? "{}"
    );
    expect("id_token" in parsed.tokens).toBe(false);
  });

  it("omits account_id when accountId is absent from OpenCode shape", () => {
    const authFileContent = JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "rt_new",
        access: "at_new",
        expires: 0,
      },
    });
    const result = detectCodexRefresh({ authFileContent, originalRefresh: original });
    const parsed = JSON.parse(result ?? "{}");
    expect("account_id" in parsed.tokens).toBe(false);
  });

  it("returns null when refresh token unchanged (no rotation happened)", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "oauth", refresh: original, access: "at_same", expires: 0 },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });

  it("returns null when openai entry is missing", () => {
    const authFileContent = JSON.stringify({
      anthropic: { type: "oauth", refresh: "rt_other", access: "at_other", expires: 0 },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });

  it("returns null when openai is api-key type (no refresh chain)", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "api", key: "sk-something" },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(
      detectCodexRefresh({ authFileContent: "{not json", originalRefresh: original })
    ).toBeNull();
  });

  it("returns null for non-object content", () => {
    expect(
      detectCodexRefresh({ authFileContent: '"a string"', originalRefresh: original })
    ).toBeNull();
  });

  it("returns null when refresh field is missing", () => {
    const authFileContent = JSON.stringify({
      openai: { type: "oauth", access: "at_new", expires: 0 },
    });
    expect(detectCodexRefresh({ authFileContent, originalRefresh: original })).toBeNull();
  });
});
