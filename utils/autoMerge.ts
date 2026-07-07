import { addFooter } from "../mcp/comment.ts";
import { countOutstandingPullfrogThreads } from "../mcp/review.ts";
import type { ToolContext } from "../mcp/server.ts";
import { checkRunsGate, hasVerifiedCheck } from "./checksGate.ts";
import { log } from "./cli.ts";
import { isPullfrog } from "./payload.ts";

/** narrow view of a PR review — the only fields the blocking-verdict logic reads. */
type ReviewVerdict = { user: { login: string } | null; state: string };

/**
 * `mergeable_state` values that mean "GitHub itself says this is not cleanly
 * mergeable right now": `dirty` (conflicts), `behind` (branch out of date under
 * strict protection), `blocked` (a required review/status/branch-protection rule
 * is unmet). `clean` and `unstable` (only non-required checks pending/failing)
 * are permitted — the CI gate below (`checkRunsGate`) independently refuses
 * red/in-flight CI, so `unstable` no longer leaks a red merge.
 */
const NON_MERGEABLE_STATES = new Set(["dirty", "behind", "blocked"]);

/**
 * true when some non-Pullfrog reviewer's latest binding verdict is
 * CHANGES_REQUESTED. GitHub returns reviews in chronological order; a later
 * APPROVED or DISMISSED from the same reviewer clears an earlier
 * CHANGES_REQUESTED, and COMMENTED/PENDING never change standing. pure so the
 * blocking-verdict logic is inspectable without the merge round-trip.
 */
function hasBlockingHumanReview(reviews: ReviewVerdict[]): boolean {
  const latestByReviewer = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || isPullfrog(login)) continue;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      latestByReviewer.set(login, review.state);
    } else if (review.state === "DISMISSED") {
      latestByReviewer.delete(login);
    }
  }
  for (const state of latestByReviewer.values()) {
    if (state === "CHANGES_REQUESTED") return true;
  }
  return false;
}

/**
 * Run-end lifecycle action: merge ANY open PR that this run mechanically
 * approved on its current head — Pullfrog acting as a full repo maintainer,
 * contributor PRs included, not just merging its own work. There is deliberately
 * NO agent-callable merge tool — the merge is a pure, deterministic consequence
 * of the runtime observing a clean approved state, so a prompt-injected agent has
 * no merge surface to reach for. Every clause is fail-closed and re-verified
 * against GitHub's own state at merge time; any failure logs why and returns
 * without merging. Best-effort — the caller wraps this in a `.catch`, and a
 * merge/comment failure can never flip the run's outcome.
 *
 * There is NO self-authorship restriction: the approval verdict IS the trust
 * decision (Pullfrog reviewed it and would approve), exactly like a human
 * maintainer merging a contributor PR. The population of mergeable PRs is bounded
 * upstream by the review triggers (`prCreated` / `prCreatedAllowNonCollaborator`)
 * — Pullfrog can only merge what it was configured to review + approve — and the
 * whole capability is opt-in per repo (clause 1). The remaining clauses are the
 * maintainer's controls.
 *
 * The invariant (all must hold):
 *   1. `ctx.autoMergeEnabled` — the per-repo toggle ANDed with the global
 *      `isAutonomousMaintenanceEnabled()` kill switch, server-side (run-context).
 *   2. `ctx.prApproveEnabled` — cannot auto-merge what it may not approve.
 *   3. this run recorded an APPROVE verdict (`toolState.approval.wouldApprove`) —
 *      Pullfrog's review is the merge decision.
 *   4. the PR is open and not a draft.
 *   5. `toolState.approval.sha === <current head sha>` — approved THIS head, so a
 *      commit pushed after the review can't ride the approval in (409-safe below).
 *   6. `countOutstandingPullfrogThreads === 0` — re-queried at merge time.
 *   7. no un-dismissed human CHANGES_REQUESTED — the human veto always wins.
 *   8. GitHub reports the PR mergeable and not blocked/dirty/behind.
 *   9. every external check-run/commit-status on the head is complete and
 *      non-failing (`checkRunsGate`) — red or in-flight CI never auto-merges,
 *      even on a repo without branch protection.
 */
export async function autoMergeAfterApprove(ctx: ToolContext): Promise<void> {
  if (!ctx.autoMergeEnabled) return;
  if (!ctx.prApproveEnabled) return;

  const approval = ctx.toolState.approval;
  if (!approval?.wouldApprove) return;

  const pullNumber = ctx.payload.event.issue_number;
  if (typeof pullNumber !== "number") return;

  const skip = (reason: string): void =>
    log.info(
      `autoMerge: pr=#${pullNumber} approvalSha=${approval.sha?.slice(0, 7)} → skipped: ${reason}`
    );

  const pr = await ctx.octokit.rest.pulls.get({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
  });

  if (pr.data.state !== "open") return skip("pr not open");
  if (pr.data.draft) return skip("pr is draft");

  const headSha = pr.data.head.sha;
  if (approval.sha !== headSha) return skip(`approval sha != head ${headSha.slice(0, 7)}`);

  const outstanding = await countOutstandingPullfrogThreads(ctx, pullNumber);
  if (outstanding > 0) return skip(`${outstanding} unresolved Pullfrog thread(s)`);

  const reviews = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listReviews, {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    per_page: 100,
  });
  if (hasBlockingHumanReview(reviews)) return skip("human changes requested");

  if (pr.data.mergeable !== true) return skip(`not mergeable (mergeable=${pr.data.mergeable})`);
  if (pr.data.mergeable_state && NON_MERGEABLE_STATES.has(pr.data.mergeable_state)) {
    return skip(`mergeable_state=${pr.data.mergeable_state}`);
  }

  // CI gate: refuse red or in-flight external checks on the head, independent of
  // branch protection (which the invariant otherwise leans on via `blocked`).
  // PAGINATED so a red check past page one can't hide. check-runs only — the app
  // holds no `statuses` permission (see checksGate.ts), so the legacy Commit
  // Statuses API is unreadable; required legacy statuses are caught by branch
  // protection via the `blocked` mergeable_state clause above.
  const checkRuns = await ctx.octokit.paginate(ctx.octokit.rest.checks.listForRef, {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    ref: headSha,
    per_page: 100,
  });
  const gate = checkRunsGate({ checkRuns });
  if (!gate.ok) return skip(`ci: ${gate.reason}`);
  // require positive verification, not merely "no red seen": a head with zero
  // check-runs passes the gate above, but since the app can't read legacy commit
  // statuses that is indistinguishable from a repo whose only (red) signal is a
  // status. auto-merge is now opt-in for any repo (no org allowlist), so refuse to
  // merge a head we can't confirm green.
  if (!hasVerifiedCheck({ checkRuns })) return skip("no completed external check-run to verify");

  // `sha` pins the merge to the exact head we verified above: GitHub returns
  // 409 (absorbed by the caller's `.catch` → no merge) if a commit landed in
  // the read→merge window, so the merge is atomic with the approved sha and a
  // TOCTOU push of an unapproved head cannot slip through.
  const merge = await ctx.octokit.rest.pulls.merge({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    sha: headSha,
    merge_method: "squash",
    commit_title: `${pr.data.title} (#${pullNumber})`,
    commit_message: "merged autonomously by Pullfrog after a clean approval.",
  });
  log.info(
    `autoMerge: pr=#${pullNumber} approvalSha=${headSha.slice(0, 7)} outstanding=0 → merged ${merge.data.sha?.slice(0, 7)}`
  );

  // attributable merge comment (carries the standard Pullfrog run footer) is the
  // durable audit artifact. best-effort — a comment failure must not undo a
  // successful merge or surface as a run error.
  await ctx.octokit.rest.issues
    .createComment({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      issue_number: pullNumber,
      body: addFooter(
        ctx,
        "> ✅ Merged autonomously after Pullfrog approved this PR and resolved all of its own review threads."
      ),
    })
    .catch((err) => log.debug(`autoMerge comment failed: ${err}`));
}
