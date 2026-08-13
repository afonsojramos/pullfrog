/**
 * Classify + render the error thrown out of the main run try-block into a
 * pair of user-facing markdown bodies — one for the GitHub Actions job
 * summary tab, one for the PR progress comment.
 *
 * Classifications, in dispatch order (first match wins; the api-key
 * branch additionally folds in the activity-timeout hang body as a
 * sub-source so a hang masking an api-key error still surfaces the api-key
 * CTA):
 *
 *   1. `BillingError` — either the proxy-token mint already threw one (402
 *      handled inline) or the agent runtime surfaced an OpenRouter
 *      "key budget exhausted" string mid-run. Both render via
 *      `formatBillingErrorSummary` so the user sees actionable copy.
 *
 *   2. BYOK provider billing-exhausted (#835) — DeepSeek "Insufficient
 *      Balance", Anthropic "credit balance is too low", OpenCode Zen
 *      `CreditsError`, Gemini "spending cap". Checked before api-key auth
 *      because billing-exhausted responses often carry 401 status codes
 *      that `isApiKeyAuthError` would otherwise mis-classify.
 *
 *   3. API-key auth error — `isApiKeyAuthError` sniffs the raw error string
 *      (or the activity-timeout hang body when present, since that's where
 *      the underlying provider error often lands); `formatApiKeyErrorSummary`
 *      renders provider + console-link copy.
 *
 *   4. ProviderModelNotFoundError — configured model id no longer in the
 *      OpenCode catalog; renders a nudge to pick a different model.
 *
 *   4a. No-provider-available (#1077) — the model IS in the catalog but the
 *      provider declines to route it on this account's plan (OpenCode Zen's
 *      own refusal string). Same "pick another model" CTA, different reason.
 *
 *   4b. Context-window overflow (#1116) — terminal `Prompt is too long` /
 *      `maximum context length is N tokens`. Actionable, so it renders on
 *      both surfaces rather than collapsing to the one-line comment.
 *
 *   4c. Transient upstream failure (#1173) — Anthropic `529 Overloaded`,
 *      OpenRouter `provider_unavailable` / `timeout`, Zen `Streaming response
 *      failed: [5xx]`. Last of the classified branches so every more specific
 *      one wins first. Renders on both surfaces: the remedy is re-triggering,
 *      which the user can only know if we say so.
 *
 *   5. Activity-timeout hang — `errorMessage` starts with
 *      `"activity timeout"` or `"agent still pending"` AND none of the
 *      above matched. The harness keeps structured diagnostic state on
 *      `toolState.agentDiagnostic`; `formatAgentHangBody` renders that into
 *      the job summary. The PR comment instead collapses to a one-line
 *      `**Run failed.** [View the logs →]` — the watchdog jargon, event
 *      counts, and benign stderr tail are operator-grade detail that only
 *      alarm the average user. The one exception is a hang masking billing
 *      exhaustion (#778), where `formatAgentHangBody` emits an actionable
 *      top-up CTA that the comment keeps verbatim.
 *
 *   6. Default — the job summary gets a plain-English lead sentence plus the
 *      raw error in a fenced code block under the `### ❌ Pullfrog failed`
 *      banner; the PR comment collapses to the same one-line logs link as
 *      the hang case, since the raw internal string helps nobody on the PR.
 *
 * Net: the actionable classifications (billing, API-key, model-not-found,
 * no-provider-available, context-overflow, transient-upstream) render identical
 * bodies on both surfaces; the non-actionable ones (hang,
 * generic) keep the forensics in the Actions job summary and show a calm
 * one-liner in the PR comment, whose footer already carries Pullfrog
 * branding + rerun links.
 */

import type { AgentDiagnostic } from "./agentHangReport.ts";
import { formatAgentHangBody } from "./agentHangReport.ts";
import {
  CREDENTIAL_REJECTED_MARKER,
  formatApiKeyErrorSummary,
  isApiKeyAuthError,
  ROUTER_UNFUNDED_MARKER,
  SECRETS_UNAVAILABLE_MARKER,
} from "./apiKeys.ts";
import { getApiUrl } from "./apiUrl.ts";
import { BillingError, formatBillingErrorSummary } from "./billingErrors.ts";
import { MODEL_ACCESS_MARKER } from "./modelAccess.ts";
import {
  extractProviderId,
  findAnthropicSpendCap,
  isOpenRouterKeyLimitExceeded,
  isProviderBillingExhausted,
  isProviderNoRoutableEndpoints,
  isRouterKeylimitExhaustedError,
  isTransientUpstreamError,
} from "./providerErrors.ts";

export type RenderedRunError = {
  summary: string;
  comment: string;
};

function isProviderModelNotFoundError(message: string): boolean {
  return message.includes("ProviderModelNotFoundError");
}

/**
 * Terminal context-window overflow (#1116). The run did real work — 5-12
 * minutes of it — and then died with no review, so the generic branch's
 * one-line comment hides the only two levers the user has: a larger-context
 * model, or a smaller PR. Covers the Claude CLI (`Prompt is too long`), the
 * OpenRouter/opencode endpoint rejection (`maximum context length is N
 * tokens`), and opencode's post-compaction give-up.
 */
function isContextOverflowError(message: string): boolean {
  return (
    /Prompt is too long/i.test(message) ||
    /Input exceeds context window/i.test(message) ||
    /maximum context length is \d+ tokens/i.test(message) ||
    /Session too large to compact/i.test(message)
  );
}

/**
 * OpenCode Zen's own server-side refusal (its `zen.api.error.noProviderAvailable`
 * string), not a CLI or catalog fault: the model is real and listed, but the
 * account's plan cannot be routed to it. Distinct from
 * `ProviderModelNotFoundError`, where the id is gone from the catalog entirely.
 * Reached most often by auto-select landing on a Zen free-tier model for an
 * account with no Zen relationship. See #1077.
 */
function isNoProviderAvailableError(message: string): boolean {
  return /\bNo provider available\b/i.test(message);
}

function formatNoProviderAvailableSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {
  const settingsUrl = `${getApiUrl()}/console/${input.owner}/${input.name}`;
  return [
    "**The provider refused to serve this model.** It's listed in the catalog, but the account this run used has no access to it — so the request was accepted and then declined.",
    "",
    "This often happens when Pullfrog auto-selects a model your account can't reach. Pin an explicit model for this repo, or add credentials for the provider that was picked.",
    "",
    `[Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

function formatContextOverflowSummary(input: { owner: string; name: string; raw: string }): string {
  const settingsUrl = `${getApiUrl()}/console/${input.owner}/${input.name}`;
  return [
    "**This run exceeded the model's context window.** Pullfrog read more than the model could hold, so it stopped before finishing.",
    "",
    `Pick a model with a larger context window, or split this PR into smaller ones and re-trigger.`,
    "",
    `[Model settings →](${settingsUrl}) · [Ask in Discord →](https://discord.gg/8y96raFg8e)`,
    "",
    `\`\`\`\n${input.raw}\n\`\`\``,
  ].join("\n");
}

/**
 * Generic failure copy for any shape not caught by a more specific classifier
 * (billing / api-key / hang / model-not-found). A plain-English lead sentence
 * so the user isn't staring at a raw internal string like
 * `opencode prompt failed: fetch failed`, followed by the actual error in a
 * fenced code block for anyone who needs the detail. Shared by both surfaces;
 * the job summary adds the `### ❌ Pullfrog failed` banner on top.
 */
function formatGenericFailure(errorMessage: string): string {
  return [
    "Pullfrog ran into an unexpected error and couldn't finish this run. The underlying error is below — re-trigger Pullfrog to try again, and reach out to support if it keeps happening.",
    "",
    "```",
    errorMessage,
    "```",
  ].join("\n");
}

/**
 * Minimal PR-comment body for non-actionable failures (hangs, unexpected
 * errors). The forensic detail (event counts, stderr tail, raw error) stays
 * in the Actions job summary; the comment the average user sees is one calm
 * line plus a link to the logs. The footer appended by `reportErrorToComment`
 * already carries rerun / model context.
 */
function formatMinimalFailureComment(repo: { owner: string; name: string }): string {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return "**Run failed.**";
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const url = `${server}/${repo.owner}/${repo.name}/actions/runs/${runId}`;
  return `**Run failed.** [View the logs →](${url})`;
}

/**
 * Best-known billing top-up URL per provider. Conservative list: only
 * providers we've actually classified billing-exhaustion shapes for in
 * `providerErrors.ts`. Unknown providers fall through to a generic CTA.
 */
const PROVIDER_BILLING_URLS: Record<string, string> = {
  deepseek: "https://platform.deepseek.com/top_up",
  anthropic: "https://console.anthropic.com/settings/billing",
  openai: "https://platform.openai.com/account/billing",
  google: "https://aistudio.google.com/usage",
  opencode: "https://opencode.ai/zen",
  xai: "https://console.x.ai/team/default/billing",
  openrouter: "https://openrouter.ai/settings/credits",
};

/**
 * `extractProviderId` only fires when the harness emits `providerID=...`
 * (OpenCode log shape). Direct-provider errors (e.g. Anthropic SDK throwing
 * `"Your credit balance is too low to access the Anthropic API"`) carry no
 * such tag, so map their distinctive copy to a provider id here so the
 * dashboard link is reachable.
 *
 * Pattern is intentionally tight (Anthropic-specific phrasing only) to
 * avoid mis-tagging non-Anthropic billing-exhausted errors that happen to
 * mention `"Anthropic API"` in passing — the broader phrase appears in
 * fallback-chain agent prompt text and OpenCode harness logs.
 */
function detectProviderId(message: string): string | null {
  const harnessId = extractProviderId(message);
  if (harnessId) return harnessId;
  if (/credit balance is too low/i.test(message)) return "anthropic";
  // xAI's exhaustion arrives via the opencode `session.error` path, which
  // carries no `providerID=` tag. its team-scoped phrasing is distinctive
  // enough to map on its own. see #1076.
  if (/used all available credits/i.test(message)) return "xai";
  // same gap, and it is the ONLY path #1135 is about: `providerID=` is folded in
  // by `withServerStderr`, which runs only on a `session.create` failure, so a
  // mid-run credit exhaustion arrives as bare wire text. without this the BYOK
  // fall-through lands on the linkless generic copy and the openrouter entry in
  // PROVIDER_BILLING_URLS is dead. see #1135.
  if (/requires more credits|Key limit exceeded \(total limit\)|openrouter\.ai/i.test(message)) {
    return "openrouter";
  }
  return null;
}

/** OpenRouter's key management page, where a key's total limit is raised. */
const OPENROUTER_KEYS_URL = "https://openrouter.ai/workspaces/default/keys";
/** OpenRouter's data-policy page, which decides what it may route to. */
const OPENROUTER_PRIVACY_URL = "https://openrouter.ai/settings/privacy";

function formatProviderBillingExhausted(input: { errorMessage: string }): string {
  const providerId = detectProviderId(input.errorMessage);
  const dashboardUrl = providerId ? PROVIDER_BILLING_URLS[providerId] : undefined;

  // a per-key ceiling is not an empty wallet, and topping up alone does not
  // clear it — the affordable figure drifts run to run while the wallet holds
  // credit. name both levers, key limit first. see #1164.
  if (isOpenRouterKeyLimitExceeded(input.errorMessage)) {
    return [
      "**Your OpenRouter key's total limit is too low for this request.**",
      "",
      "OpenRouter refused the request against the key's own spending ceiling, not your account balance — raising or removing that limit is the fix, and topping up credits alone may not be.",
      "",
      `[Raise the key's limit →](${OPENROUTER_KEYS_URL}) · [Add credits →](${PROVIDER_BILLING_URLS.openrouter})`,
      "",
      `\`\`\`\n${input.errorMessage}\n\`\`\``,
    ].join("\n");
  }

  // a Console-set spend cap is not an empty wallet — topping up clears nothing,
  // and the provider already told us when access comes back. see #1208.
  const spendCap = findAnthropicSpendCap(input.errorMessage);
  if (spendCap) {
    const regains = spendCap.regainAt ? ` Access returns on **${spendCap.regainAt}**.` : "";
    return [
      `**Your \`anthropic\` account has reached its configured API usage limit.**${regains}`,
      "",
      "Anthropic refused the request against a spend limit set in your Console, not an empty balance — raise or remove that limit to run before it resets.",
      "",
      `[Anthropic billing settings →](${PROVIDER_BILLING_URLS.anthropic})`,
      "",
      `\`\`\`\n${input.errorMessage}\n\`\`\``,
    ].join("\n");
  }

  const headline = providerId
    ? `**Your \`${providerId}\` account is out of credit.**`
    : "**Your provider account is out of credit.**";
  const cta = dashboardUrl
    ? `[Top up \`${providerId}\` →](${dashboardUrl})`
    : "Top up your provider account, then re-trigger Pullfrog.";

  return [
    headline,
    "",
    "Pullfrog detected a billing-exhausted response from your provider — the agent stopped before completing this run.",
    "",
    cta,
    "",
    `\`\`\`\n${input.errorMessage}\n\`\`\``,
  ].join("\n");
}

/**
 * A transient upstream failure — the model provider 5xx'd or dropped the
 * stream. Nothing the user configured is wrong, so the only useful thing to
 * say is which provider, that it was upstream, and that re-triggering is the
 * remedy.
 */
function formatTransientUpstreamBody(errorMessage: string): string {
  const providerId = detectProviderId(errorMessage);
  const who = providerId ? `\`${providerId}\`` : "the model provider";
  return [
    `**${who} had a temporary upstream failure.**`,
    "",
    "The provider refused or dropped the request mid-run — nothing in your repo or your credentials is at fault. Re-trigger Pullfrog; if it keeps happening, check the provider's status page.",
    "",
    `\`\`\`\n${errorMessage}\n\`\`\``,
  ].join("\n");
}

/**
 * OpenRouter has nowhere it is permitted to route the picked model. Nothing is
 * billed and no key is at fault, so neither the billing nor the api-key copy
 * fits — both would send the user to fix something that is not broken.
 */
function formatProviderNoRoutableEndpoints(input: {
  owner: string;
  name: string;
  errorMessage: string;
}): string {
  return [
    "**OpenRouter can't route this model anywhere your account allows.**",
    "",
    "Your OpenRouter data policy excludes every provider currently serving the configured model, so the request was refused before any model work happened. Allow more providers, or pick a model your policy already covers.",
    "",
    `[OpenRouter data policy →](${OPENROUTER_PRIVACY_URL}) · [Configure model →](${getApiUrl()}/console/${input.owner}/${input.name})`,
    "",
    `\`\`\`\n${input.errorMessage}\n\`\`\``,
  ].join("\n");
}

function formatProviderModelNotFoundSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {
  return (
    `The configured model is no longer available in OpenCode's catalog. ` +
    `Pick a different model in the Pullfrog console for \`${input.owner}/${input.name}\`, ` +
    `or contact support if this persists.\n\n` +
    `\`\`\`\n${input.raw}\n\`\`\``
  );
}

export function renderRunError(input: {
  errorMessage: string;
  repo: { owner: string; name: string };
  agentDiagnostic: AgentDiagnostic | undefined;
  /** the run is spending Pullfrog's Router wallet (a proxy key was minted), not
   * the user's own provider credential. `payload.proxyModel` at both call
   * sites. */
  routerActive: boolean;
}): RenderedRunError {
  // reclassify mid-run OpenRouter "key budget exhausted" as BillingError so
  // the user gets the same actionable copy as a /api/proxy-token 402.
  //
  // gated on `routerActive`: the identical wire text is emitted when a BYOK
  // customer's OWN OpenRouter wallet runs dry, and sending them to top up a
  // Pullfrog Router balance they don't use is advice that cannot work. on a BYOK
  // run this falls through to the provider-billing branch below, which now
  // matches the same shapes and links openrouter.ai instead. see #1135.
  const billingError =
    input.routerActive && isRouterKeylimitExhaustedError(input.errorMessage)
      ? new BillingError(input.errorMessage, { code: "router_keylimit_exhausted" })
      : null;

  if (billingError) {
    const body = formatBillingErrorSummary(billingError, input.repo.owner);
    return { summary: body, comment: body };
  }

  // model-access gate (explicit `--model`/family flag the run can't serve):
  // the thrown message already IS the rendered markdown body (built by
  // `buildModelAccessError`), so surface it verbatim on both surfaces.
  if (input.errorMessage.includes(MODEL_ACCESS_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // run-context couldn't hand over Pullfrog-stored secrets. same verbatim
  // contract as the model-access body above, and checked before the api-key
  // branch below so it can't be rewritten into a "go add a key" CTA — the key
  // is already there.
  if (input.errorMessage.includes(SECRETS_UNAVAILABLE_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // an unfunded Router account whose BYOK search also came up empty. same
  // verbatim contract, and likewise ahead of the api-key branch — that branch
  // rebuilds any body carrying `no API key found` into the generic
  // "add a provider key" copy, which is the exact wrong CTA here.
  if (input.errorMessage.includes(ROUTER_UNFUNDED_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // a credential the provider rejected before the agent started. the body
  // already names the credential and its real remedy, and it QUOTES the
  // provider's wording — so without this guard the api-key branch below sniffs
  // that quote and rebuilds it into the generic "rotate your key" CTA.
  if (input.errorMessage.includes(CREDENTIAL_REJECTED_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // gated on isHang because the harness sets `agentDiagnostic` on entry, so
  // any non-hang throw that hits the outer catch (e.g. post-success
  // output_schema validator, or a late cleanup throw after the run already
  // succeeded) would otherwise render "Pullfrog failed" with stale event
  // counts and silently drop the real errorMessage.
  const isHang =
    input.errorMessage.startsWith("activity timeout") ||
    input.errorMessage.startsWith("agent still pending");
  const hangBody = isHang
    ? formatAgentHangBody({
        diagnostic: input.agentDiagnostic,
        isHang: true,
        errorMessage: input.errorMessage,
      })
    : null;

  // BYOK provider billing-exhausted (DeepSeek "Insufficient Balance",
  // Anthropic "credit balance is too low", OpenCode Zen `CreditsError` /
  // `FreeUsageLimitError`, Gemini "spending cap"). distinct from the Router
  // billing branches above — Router uses `BillingError`, this uses the agent
  // log payload classified by `isProviderBillingExhausted`. see #835.
  //
  // checked BEFORE api-key auth: providers commonly return 401 (DeepSeek,
  // Gemini) or include `"API Error: 401"` in the error body for billing
  // exhaustion, which `isApiKeyAuthError` would otherwise match — surfacing
  // a "rotate your key" CTA when the actual fix is "top up credits".
  if (isProviderBillingExhausted(input.errorMessage)) {
    const body = formatProviderBillingExhausted({ errorMessage: input.errorMessage });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // routable-endpoint refusal, checked alongside the billing branch for the
  // same reason: it is user-fixable provider configuration, and the generic
  // renderer below would surface the raw wire text with no CTA at all.
  if (isProviderNoRoutableEndpoints(input.errorMessage)) {
    const body = formatProviderNoRoutableEndpoints({
      owner: input.repo.owner,
      name: input.repo.name,
      errorMessage: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  const apiKeySource = hangBody ?? input.errorMessage;
  const apiKeyErrorSummary = isApiKeyAuthError(apiKeySource)
    ? formatApiKeyErrorSummary({
        owner: input.repo.owner,
        name: input.repo.name,
        raw: apiKeySource,
      })
    : null;

  if (apiKeyErrorSummary) {
    return { summary: apiKeyErrorSummary, comment: apiKeyErrorSummary };
  }

  if (isProviderModelNotFoundError(input.errorMessage)) {
    const body = formatProviderModelNotFoundSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: body, comment: body };
  }

  if (isNoProviderAvailableError(input.errorMessage)) {
    const body = formatNoProviderAvailableSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // actionable, so it renders identically on both surfaces rather than
  // collapsing the comment to the hang/generic one-liner. see #1116.
  if (isContextOverflowError(input.errorMessage)) {
    const body = formatContextOverflowSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  // an upstream blip is not ours, but the silence about it was: the provider
  // handed us accurate, actionable copy and the comment said `Run failed.`
  // while up to 38 tool calls of finished review work went in the bin (#1173).
  // last of the classified branches, so every specific one still wins.
  if (isTransientUpstreamError(input.errorMessage)) {
    const body = formatTransientUpstreamBody(input.errorMessage);
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  if (hangBody) {
    // a hang masking billing exhaustion (#778) renders an actionable top-up
    // CTA inside `hangBody` — keep that in the comment. every other hang is
    // non-actionable noise for the average user, so the comment collapses to
    // a one-liner and the diagnostic stays in the Actions job summary.
    //
    // the test is "did we classify the provider's own refusal", not the single
    // billing label: `quota error`, `rate limited` and the `auth error (*)`
    // family are as actionable as an empty wallet, and pinning it to one label
    // gave 17 customers a blank comment while we held a message naming their
    // quota's reset time (#1183). an unexplained hang still collapses.
    const explained = input.agentDiagnostic?.lastProviderError !== undefined;
    return {
      summary: `### ❌ Pullfrog failed\n\n${hangBody}`,
      comment: explained ? hangBody : formatMinimalFailureComment(input.repo),
    };
  }

  const genericBody = formatGenericFailure(input.errorMessage);
  return {
    summary: `### ❌ Pullfrog failed\n\n${genericBody}`,
    comment: formatMinimalFailureComment(input.repo),
  };
}
