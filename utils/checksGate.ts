/**
 * Shared, dependency-free CI green/red predicate — the single source of truth for
 * "given these check-runs, is this PR head safe to merge?". Consumed by the
 * auto-merge path: `autoMerge.ts` gates the PR head at merge time, and the
 * `pr-merge-completion` webhook re-checks it before dispatching a slow-CI re-wake.
 * A red or in-flight sha never merges, and a sha with no confirmable green
 * check-run is treated as unverified (refused, not merged blind).
 *
 * Gates on the Checks API only. The Pullfrog App deliberately holds no `statuses`
 * permission (requesting it would force re-approval on every install — see
 * wiki/app-permissions.md), so the legacy Commit Statuses API is unreadable
 * (`listCommitStatusesForRef` 403s). Modern CI (GitHub Actions, etc.) reports via
 * check-runs; a repo relying on the legacy Statuses API is covered by branch
 * protection instead — a failing required status makes `mergeable_state` `blocked`,
 * which the merge invariant already refuses (`NON_MERGEABLE_STATES`).
 */

export type CheckRun = { name: string; status: string; conclusion: string | null };

/** check-run conclusions that do NOT block. everything else refuses (fail-closed). */
const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Pullfrog's own check names, excluded from the gate: they are a run's own verdict
 * (redundant with the caller's own invariants), not external CI.
 */
const PULLFROG_CHECKS = new Set(["pullfrog", "pullfrog-approval"]);

/**
 * Refuse if any external check-run is incomplete (queued/in_progress) or concluded
 * anything other than success/neutral/skipped. Fail-closed on unknown/absent
 * conclusions. Pure so the pass/fail logic is inspectable directly.
 */
export function checkRunsGate(params: { checkRuns: CheckRun[] }): {
  ok: boolean;
  reason: string;
} {
  for (const run of params.checkRuns) {
    if (PULLFROG_CHECKS.has(run.name.toLowerCase())) continue;
    if (run.status !== "completed")
      return { ok: false, reason: `check "${run.name}" ${run.status}` };
    if (!OK_CONCLUSIONS.has(run.conclusion ?? "")) {
      return { ok: false, reason: `check "${run.name}" concluded ${run.conclusion}` };
    }
  }
  return { ok: true, reason: "all checks passed" };
}

/**
 * true when the head has ≥1 CONCLUDED non-failing EXTERNAL check-run — CI
 * positively ran, not merely "no red was seen". paired with `checkRunsGate.ok`
 * (any completed check is non-failing), this == "≥1 concluded non-failing check".
 * the merge requires it: a head with ZERO check-runs passes
 * `checkRunsGate` (nothing red) but has no verification, and since the app can't
 * read legacy commit statuses, "zero check-runs" is indistinguishable from "green
 * Actions but a red CircleCI status" — so we only act on a head we can positively
 * confirm is green. Pullfrog's own verdict checks don't count as external CI.
 */
export function hasVerifiedCheck(params: { checkRuns: CheckRun[] }): boolean {
  return params.checkRuns.some(
    (r) => !PULLFROG_CHECKS.has(r.name.toLowerCase()) && r.status === "completed"
  );
}
