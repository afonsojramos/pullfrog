/**
 * Which instruction profile a run assembles.
 *
 * `full` reproduces the prompt as of 2026-07-28 byte-for-byte; `lean` is the cut that trusts the
 * model's own judgement instead of enumerating every case. Read from env (not run context) so a
 * single deployed build can serve both arms of an A/B.
 *
 * Anything other than `full` resolves to `lean`, so a typo'd value lands in the treatment arm
 * silently — `logRunStartup` prints the RESOLVED arm for exactly that reason.
 *
 * Prefer driving the arm from the workflow `env:` block over `unsafe_overrides`: the override path
 * runs `core.setSecret()` on every applied value (`overrides.ts`), and the runner then
 * substring-masks that value everywhere downstream, so `full` turns `successfully` into
 * `success***y` and corrupts the very logs an A/B reads.
 */
export type PromptProfile = "lean" | "full";

export function promptProfile(): PromptProfile {
  return process.env.PULLFROG_PROMPT_PROFILE === "full" ? "full" : "lean";
}

/** Pick between the two profiles' text. Keeps the branch legible at each cut site. */
export function byProfile(lean: string, full: string): string {
  return promptProfile() === "lean" ? lean : full;
}
