import type { RestEndpointMethodTypes } from "@octokit/rest";
import type { ToolContext } from "../mcp/server.ts";
import { primaryRepoState } from "../toolState.ts";
import { log } from "./cli.ts";

/**
 * commit-status check-run names. `pullfrog` is the review-verdict-agnostic run
 * completion check (lets a repo require `pullfrog` so branch protection stops
 * hanging at "waiting for status"); `pullfrog-approval` correlates with whether
 * Pullfrog would approve the PR under current review logic.
 */
const COMPLETION_CHECK = "pullfrog";
const APPROVAL_CHECK = "pullfrog-approval";

type Conclusion = "success" | "failure";

async function createCheckRun(
  ctx: ToolContext,
  params: { name: string; headSha: string; conclusion: Conclusion; title: string; summary: string }
): Promise<void> {
  const createParams: RestEndpointMethodTypes["checks"]["create"]["parameters"] = {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    name: params.name,
    head_sha: params.headSha,
    status: "completed",
    conclusion: params.conclusion,
    output: { title: params.title, summary: params.summary },
  };
  if (ctx.runId) {
    createParams.details_url = `https://github.com/${ctx.repo.owner}/${ctx.repo.name}/actions/runs/${ctx.runId}`;
  }
  await ctx.octokit.rest.checks.create(createParams);
  log.info(`» posted ${params.name} check (${params.conclusion}) on ${params.headSha.slice(0, 7)}`);
}

/**
 * post the opt-in `pullfrog` (run completion) and `pullfrog-approval` (review
 * verdict) commit-status check-runs so they can be required by branch
 * protection. no-op unless the `status_checks` input is enabled and the run is
 * on a pull request.
 *
 * terminal-only by design: we never create an `in_progress` check. a
 * hard-cancelled run (SIGKILL) would strand a required check `in_progress` and
 * block merges forever; an absent required check already blocks merge the same
 * way while the run is in flight, with no stuck-check failure mode.
 *
 *   - `pullfrog` is posted on every PR run: success iff the run finished
 *     successfully, failure on error/timeout. review-verdict-agnostic.
 *   - `pullfrog-approval` is posted only when this run produced an approval
 *     verdict (`toolState.approval`, set by create_pull_request_review),
 *     anchored to the reviewed sha so a mid-run push leaves the new head
 *     unapproved until the follow-up re-review reports.
 *
 * best-effort throughout: a check-post failure (fork PR head not in the base
 * repo, transient 5xx, closed PR) must never flip the run's own outcome.
 */
export async function reportStatusChecks(
  ctx: ToolContext,
  params: { runSucceeded: boolean }
): Promise<void> {
  if (!ctx.payload.statusChecks) return;
  const event = ctx.payload.event;
  const pullNumber = event.issue_number;
  if (event.is_pr !== true || typeof pullNumber !== "number") return;

  let headSha: string;
  try {
    const pr = await ctx.octokit.rest.pulls.get({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      pull_number: pullNumber,
    });
    headSha = pr.data.head.sha;
  } catch (err) {
    log.debug(`status checks: failed to resolve PR #${pullNumber} head sha: ${err}`);
    return;
  }

  const completionSha = primaryRepoState(ctx.toolState).checkoutSha ?? headSha;
  await createCheckRun(ctx, {
    name: COMPLETION_CHECK,
    headSha: completionSha,
    conclusion: params.runSucceeded ? "success" : "failure",
    title: params.runSucceeded ? "Pullfrog run completed" : "Pullfrog run failed",
    summary: params.runSucceeded
      ? "The Pullfrog run finished successfully."
      : "The Pullfrog run failed or timed out. See the run logs for details.",
  }).catch((err) => log.debug(`status checks: ${COMPLETION_CHECK} post failed: ${err}`));

  // only assert an approval verdict when the run cleanly completed. the verdict
  // is recorded before create_pull_request_review actually submits, so on a
  // failed/crashed run the review may not have landed — leave pullfrog-approval
  // absent (the next run resolves it) rather than post a stale verdict.
  const approval = ctx.toolState.approval;
  if (params.runSucceeded && approval) {
    await createCheckRun(ctx, {
      name: APPROVAL_CHECK,
      headSha: approval.sha ?? headSha,
      conclusion: approval.wouldApprove ? "success" : "failure",
      title: approval.wouldApprove ? "Pullfrog would approve" : "Pullfrog would not approve",
      summary: approval.wouldApprove
        ? "Pullfrog has no outstanding review feedback on this PR."
        : "Pullfrog has outstanding review feedback or requested changes on this PR.",
    }).catch((err) => log.debug(`status checks: ${APPROVAL_CHECK} post failed: ${err}`));
  }
}
