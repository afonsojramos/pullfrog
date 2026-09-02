/**
 * provider catalog — the source of truth for `providers-live` (full harness
 * smoke per provider).
 *
 * each entry pins one standard-tier flagship slug per provider — not the
 * pro/opus tier (too expensive) and not the free/experimental tier (too
 * flaky). these flagships catch provider-class regressions like Gemini schema
 * sanitization or OpenAI tool-call format drift that the cheap per-alias CLI
 * smoke can't see.
 *
 * adding a new provider:
 *   1. add an entry here with the flagship slug and agent harness
 *   2. add a row to wiki/models-catalog.md "To add a provider"
 *   3. CI picks it up automatically — no workflow change
 */

export type ProviderEntry = {
  name: string;
  /** flagship slug for `providers-live` full-harness smoke. */
  flagship: string;
  /** harness used by the runtime for this provider's models. */
  agent: "claude" | "opencode";
  /**
   * CI holds no credential for this provider, so `models-live` and
   * `providers-live` emit no cell for it — every cell would fail on auth
   * rather than on anything the smoke is asking about.
   *
   * Deliberately a per-provider opt-out and NOT "skip whenever the env var is
   * missing": the second one also swallows a rotation accident on a provider we
   * do hold a key for, which is exactly what these jobs exist to catch. Delete
   * the flag the moment the secret lands — the rest of the entry is already
   * correct and the cells arm themselves.
   */
  noCiCredential?: true;
};

export const providers: ProviderEntry[] = [
  {
    name: "anthropic",
    flagship: "anthropic/claude-sonnet",
    agent: "claude",
  },
  {
    name: "openai",
    flagship: "openai/gpt-sol",
    agent: "opencode",
  },
  {
    name: "google",
    flagship: "google/gemini-pro",
    agent: "opencode",
  },
  {
    name: "xai",
    flagship: "xai/grok",
    agent: "opencode",
  },
  {
    name: "deepseek",
    flagship: "deepseek/deepseek-pro",
    agent: "opencode",
  },
  {
    name: "moonshotai",
    flagship: "moonshotai/kimi-k2",
    agent: "opencode",
  },
  {
    // the flagship is the all-tier model on purpose: K3 and HighSpeed 401 on a
    // membership below Moderato / Allegretto, so any lower-tier CI key would
    // fail them for a reason the smoke isn't testing.
    name: "kimi-for-coding",
    flagship: "kimi-for-coding/kimi-k2",
    agent: "opencode",
    noCiCredential: true,
  },
  {
    // one gateway key fronts every vendor; sonnet is the standard tier there too.
    name: "vercel",
    flagship: "vercel/claude-sonnet",
    agent: "opencode",
  },
  {
    name: "opencode",
    flagship: "opencode/big-pickle",
    agent: "opencode",
  },
  {
    name: "openrouter",
    flagship: "openrouter/claude-sonnet",
    agent: "opencode",
  },
  {
    name: "opencode-go",
    flagship: "opencode-go/glm",
    agent: "opencode",
  },
];
