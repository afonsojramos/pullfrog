/**
 * provider catalog — the source of truth for `providers-live` (full harness
 * smoke per provider) and the per-provider coverage globs that scope `models-live`
 * (per-alias CLI smoke).
 *
 * each entry pins one standard-tier flagship slug per provider — not the
 * pro/opus tier (too expensive for per-push) and not the free/experimental
 * tier (too flaky). these flagships catch provider-class regressions like
 * Gemini schema sanitization or OpenAI tool-call format drift that the cheap
 * per-alias CLI smoke can't see.
 *
 * `coverage` lists the source files that, when changed, should rerun this
 * provider's flagship + every alias of this provider. `action/models.ts` is
 * included on every entry — touching the resolution table reruns all model
 * tests (simple model; matches the per-PR-precision answer from planning).
 *
 * adding a new provider:
 *   1. add an entry here with the flagship slug, agent harness, coverage globs
 *   2. add a row to wiki/models-catalog.md "To add a provider"
 *   3. CI picks it up automatically — no workflow change
 */

export type ProviderEntry = {
  name: string;
  /** flagship slug for `providers-live` full-harness smoke. */
  flagship: string;
  /** harness used by the runtime for this provider's models. */
  agent: "claude" | "opencode";
  /** repo-relative globs that invalidate this provider's matrix entries. */
  coverage: string[];
  /**
   * CI holds no credential for this provider, so `models-live` and
   * `providers-live` emit no cell for it — the entry exists only to carry
   * `coverage`, without which every alias of this provider would run on EVERY
   * push (an undeclared coverage set reads as "any change touches me", the
   * `opencode-go` lesson below).
   *
   * Deliberately a per-provider opt-out and NOT "skip whenever the env var is
   * missing": the second one also swallows a rotation accident on a provider we
   * do hold a key for, which is exactly what these jobs exist to catch. Delete
   * the flag the moment the secret lands — the rest of the entry is already
   * correct and the cells arm themselves.
   */
  noCiCredential?: true;
};

/** what EVERY provider entry depends on: the resolution table, and the runner
 * that executes each alias cell. `model-smoke.ts` matched no glob at all before
 * this, so editing it produced an empty matrix and CI went green having run none
 * of it. */
const SHARED_COVERAGE = ["action/models.ts", "action/test/model-smoke.ts"];

const SHARED_OPENCODE_COVERAGE = [
  ...SHARED_COVERAGE,
  "action/agents/opencode.ts",
  "action/agents/opencodePlugin.ts",
];

export const providers: ProviderEntry[] = [
  {
    name: "anthropic",
    flagship: "anthropic/claude-sonnet",
    agent: "claude",
    coverage: [...SHARED_COVERAGE, "action/agents/claude.ts"],
  },
  {
    name: "openai",
    flagship: "openai/gpt-sol",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "google",
    flagship: "google/gemini-pro",
    agent: "opencode",
    coverage: [...SHARED_OPENCODE_COVERAGE, "action/mcp/geminiSanitizer.ts"],
  },
  {
    name: "xai",
    flagship: "xai/grok",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "deepseek",
    flagship: "deepseek/deepseek-pro",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "moonshotai",
    flagship: "moonshotai/kimi-k2",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    // the flagship is the all-tier model on purpose: K3 and HighSpeed 401 on a
    // membership below Moderato / Allegretto, so any lower-tier CI key would
    // fail them for a reason the smoke isn't testing.
    name: "kimi-for-coding",
    flagship: "kimi-for-coding/kimi-k2",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
    noCiCredential: true,
  },
  {
    // one gateway key fronts every vendor; sonnet is the standard tier there too.
    name: "vercel",
    flagship: "vercel/claude-sonnet",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "opencode",
    flagship: "opencode/big-pickle",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  {
    name: "openrouter",
    flagship: "openrouter/claude-sonnet",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
  // this entry was missing, and an absent provider does not mean "skip" — a
  // `coverage` nobody declared reads as "any change touches me", so both
  // `opencode-go` aliases smoked on EVERY push, docs-only ones included. that
  // is the one live-model cost no filter could reach.
  {
    name: "opencode-go",
    flagship: "opencode-go/glm",
    agent: "opencode",
    coverage: SHARED_OPENCODE_COVERAGE,
  },
];
