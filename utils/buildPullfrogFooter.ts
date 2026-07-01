import {
  getModelProvider,
  isAutoTier,
  modelAliases,
  providers,
  resolveDisplayAlias,
} from "../models.ts";

export const PULLFROG_DIVIDER = "<!-- PULLFROG_DIVIDER_DO_NOT_REMOVE_PLZ -->";

const FROG_LOGO = `<a href="https://pullfrog.com"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/logos/frog-white-full-18px.png"><img src="https://pullfrog.com/logos/frog-green-full-18px.png" width="9px" height="9px" style="vertical-align: middle; " alt="Pullfrog"></picture></a>`;

export interface WorkflowRunFooterInfo {
  owner: string;
  repo: string;
  runId: number;
  /** optional job ID - if provided, will append /job/{jobId} to the workflow run URL */
  jobId?: string | undefined;
}

export interface BuildPullfrogFooterParams {
  /** add "via Pullfrog" link */
  triggeredBy?: boolean;
  /** add "View workflow run" link */
  workflowRun?: WorkflowRunFooterInfo | undefined;
  /** alternative: just pass a pre-built URL directly (for shortlinks etc.) */
  workflowRunUrl?: string | undefined;
  /** arbitrary custom parts (e.g., action links) */
  customParts?: string[] | undefined;
  /** model slug from payload (e.g., "anthropic/claude-opus"). shown in footer as "Using `Model Name`" */
  model?: string | undefined;
  /**
   * When the action engaged the BYOK fallback, this is the slug the user
   * had configured (e.g. "anthropic/claude-opus") — the footer renders
   * `Using <free model> (credentials for <configured> not configured)`
   * so the substitution is visible in PR comments + reviews.
   */
  fallbackFrom?: string | undefined;
  /**
   * When a Router account had a model (or the intelligent tier) selected that
   * the server clamped to the efficient default — custom picks are card-gated
   * wholesale. `from` is the configured slug (e.g. "anthropic/claude-opus");
   * `reason` names the binding constraint — "card" (no card on file) renders
   * `Using <Kimi K2> (<Claude Opus> needs a card on file)`, "noRouterPath"
   * (no openRouterResolve yet and no stored provider key) renders a
   * provider-key nudge — so the downgrade is visible rather than silently
   * presenting Kimi as the pick.
   */
  clamped?: { from: string; reason: "card" | "noRouterPath" } | undefined;
  /**
   * true when the run used the default proxy model only because no model was
   * selected (Router billing + "auto"). the footer appends a note nudging the
   * user to pick a model — the cost-optimized default is a weaker reviewer
   * than a frontier model.
   */
  unselectedProxyDefault?: boolean | undefined;
  /**
   * true when the action is pinned to a full commit SHA — the footer leads
   * with a maintenance nudge to switch to the moving `@v0` tag (a SHA pin
   * freezes the post-run cleanup step, which silently fails the workflow).
   */
  shaPinned?: boolean | undefined;
  /**
   * true when the run's model costs are covered by the Pullfrog for OSS
   * program — the footer renders `Using <model> (free via Pullfrog for OSS)`
   * with the phrase linking to the OSS application page.
   */
  oss?: boolean | undefined;
}

/** Provider display name (e.g. "Anthropic") for the slug, or the raw provider segment as a fallback. */
function providerDisplayName(slug: string): string {
  try {
    const key = getModelProvider(slug);
    const meta = providers[key as keyof typeof providers];
    return meta?.displayName ?? key;
  } catch {
    // raw IDs without a `/` (Bedrock model IDs) — never reach this function
    // in practice because the BYOK fallback skips Bedrock, but defensively
    // return the slug itself rather than throw if it ever does.
    return slug;
  }
}

function formatModelLabel(params: {
  model: string;
  fallbackFrom?: string | undefined;
  clamped?: { from: string; reason: "card" | "noRouterPath" } | undefined;
  unselectedProxyDefault?: boolean | undefined;
  oss?: boolean | undefined;
}): string {
  const alias =
    resolveDisplayAlias(params.model) ??
    // reverse-lookup: when the caller passes an effective model (proxy or
    // resolved target like "openrouter/anthropic/claude-opus-4.7") instead of
    // a stored alias slug, find the alias whose resolve target matches so we
    // still render a friendly display name.
    modelAliases.find((a) => a.resolve === params.model || a.openRouterResolve === params.model);
  const displayName = alias?.displayName ?? params.model;
  // OSS runs have their model costs covered by the program — surface that
  // (and link to the application) instead of the BYOK `(free)` note.
  if (params.oss) {
    return `\`${displayName}\` (free via [Pullfrog for OSS](https://pullfrog.com/for-oss))`;
  }
  const base = alias?.isFree ? `\`${displayName}\` (free)` : `\`${displayName}\``;
  if (params.fallbackFrom) {
    return `${base} (credentials for ${providerDisplayName(params.fallbackFrom)} not configured)`;
  }
  if (params.clamped) {
    // name the tier (not its backing model) when the user picked a tier, so the
    // public copy reads right and doesn't couple to the tier's current target.
    const target = isAutoTier(params.clamped.from)
      ? "the intelligent tier"
      : `\`${resolveDisplayAlias(params.clamped.from)?.displayName ?? params.clamped.from}\``;
    return params.clamped.reason === "card"
      ? `${base} (${target} needs a [card on file](https://docs.pullfrog.com/models))`
      : `${base} (${target} needs a [provider key](https://docs.pullfrog.com/models) — no Router support yet)`;
  }
  if (params.unselectedProxyDefault) {
    return `${base} (default — [pick a model](https://docs.pullfrog.com/models) for stronger reviews)`;
  }
  return base;
}

/**
 * build a pullfrog footer with configurable parts
 * always includes: frog logo at start and X link at end
 * order: action links (customParts) > workflow run > model > attribution > reference links
 */
export function buildPullfrogFooter(params: BuildPullfrogFooterParams): string {
  const parts: string[] = [];

  if (params.shaPinned) {
    parts.push(
      "⚠️ this action is pinned to a commit SHA, which [freezes the cleanup step](https://docs.pullfrog.com/versioning) — switch to `@v0` or keep the SHA fresh with Dependabot"
    );
  }

  if (params.customParts) {
    parts.push(...params.customParts);
  }

  if (params.workflowRunUrl) {
    parts.push(`[View workflow run](${params.workflowRunUrl})`);
  } else if (params.workflowRun) {
    const baseUrl = `https://github.com/${params.workflowRun.owner}/${params.workflowRun.repo}/actions/runs/${params.workflowRun.runId}`;
    const url = params.workflowRun.jobId ? `${baseUrl}/job/${params.workflowRun.jobId}` : baseUrl;
    parts.push(`[View workflow run](${url})`);
  }

  if (params.triggeredBy) {
    parts.push("via [Pullfrog](https://pullfrog.com)");
  }

  if (params.model) {
    parts.push(
      `Using ${formatModelLabel({
        model: params.model,
        fallbackFrom: params.fallbackFrom,
        clamped: params.clamped,
        unselectedProxyDefault: params.unselectedProxyDefault,
        oss: params.oss,
      })}`
    );
  }

  const allParts = [...parts, "[𝕏](https://x.com/pullfrogai)"];

  return `\n\n${PULLFROG_DIVIDER}\n<sup>${FROG_LOGO}&nbsp;&nbsp;｜ ${allParts.join(" ｜ ")}</sup>`;
}

/**
 * strip any existing pullfrog footer from a comment body
 */
export function stripExistingFooter(body: string): string {
  const dividerIndex = body.indexOf(PULLFROG_DIVIDER);
  if (dividerIndex === -1) {
    return body;
  }
  return body.substring(0, dividerIndex).trimEnd();
}
