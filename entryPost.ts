#!/usr/bin/env node
//
// GitHub Actions `post:` entry point. Runs after the main step regardless of
// exit status (cancellation, timeout, unhandled error) — that's the contract
// we need for credential persistence: if OpenCode refreshed the Codex
// auth.json during the run, the refreshed token must land back in Pullfrog
// even when the main step died unexpectedly.
//
// THIS IS WHY `CODEX_AUTH_JSON` HAS TO LIVE IN PULLFROG'S OWN SECRET STORE,
// NOT IN GITHUB ACTIONS SECRETS. The refresh chain rotates on every use; this
// hook PUTs the rotated chain back to Pullfrog Postgres so the next run starts
// from a fresh token. GH Actions secrets are read-only at runtime — there is
// no API to write them back from inside a job — so a token stashed there
// silently goes stale on the first refresh and the next run fails. See
// wiki/codex-auth.md.
//
// Today's only job: detect a Codex auth refresh by diffing the on-disk
// auth.json against the original refresh token (saved to GH Actions state
// by action/agents/opencode.ts — see also the legacy v1 file kept as
// reference at action/agents/opencode.ts), convert OpenCode's auth shape
// back to Codex CLI shape, and PUT it to /api/runtime/secret.
//
// Silent no-op when the main step didn't materialize Codex auth (no state
// saved). Best-effort: failures are logged but never throw — the workflow
// is already done, and a missed refresh write-back means the user re-runs
// `pullfrog auth codex` next time the chain breaks.
//
// Imports here MUST stay stdlib-only — GHA runs this file directly from the
// checked-out action repo, which has no node_modules for sha-pinned consumers.

import { existsSync, readFileSync } from "node:fs";
import {
  detectCodexRefresh,
  detectXaiRefresh,
  type OAuthWriteback,
} from "./utils/codexRefreshDetect.ts";
import * as core from "./utils/ghaCore.ts";
import { postApiFetch } from "./utils/postApiFetch.ts";

async function main(): Promise<void> {
  const raw = core.getState("oauth_writeback");
  if (!raw) {
    core.info("oauth post-hook: no writeback state — skipping");
    return;
  }

  let state: { apiToken: string; entries: OAuthWriteback[] };
  try {
    state = JSON.parse(raw) as typeof state;
  } catch (err) {
    core.warning(`oauth post-hook: malformed writeback state — ${err}`);
    return;
  }
  if (!state.apiToken || !Array.isArray(state.entries)) {
    core.warning("oauth post-hook: incomplete writeback state — skipping");
    return;
  }

  for (const entry of state.entries) {
    await writeBackEntry(state.apiToken, entry);
  }
}

/** Persist one provider's rotated chain. Each entry is independent — a
 * failure on one must not strand the other, so this never throws. */
async function writeBackEntry(apiToken: string, entry: OAuthWriteback): Promise<void> {
  if (!entry.secretName || !entry.authPath || !entry.originalRefresh) {
    core.warning("oauth post-hook: incomplete writeback entry — skipping");
    return;
  }
  if (!existsSync(entry.authPath)) {
    core.info(`oauth post-hook: ${entry.authPath} not found — nothing to write back`);
    return;
  }

  let authFileContent: string;
  try {
    authFileContent = readFileSync(entry.authPath, "utf8");
  } catch (err) {
    core.warning(`oauth post-hook: cannot read ${entry.authPath} — ${err}`);
    return;
  }

  const refreshed =
    entry.provider === "xai"
      ? detectXaiRefresh({
          authFileContent,
          originalRefresh: entry.originalRefresh,
        })
      : detectCodexRefresh({
          authFileContent,
          originalRefresh: entry.originalRefresh,
          originalIdToken: entry.originalIdToken,
        });
  if (!refreshed) {
    core.info(`oauth post-hook: ${entry.secretName} chain unchanged — no writeback needed`);
    return;
  }

  try {
    const response = await postApiFetch({
      path: "/api/runtime/secret",
      method: "PUT",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: entry.secretName, value: refreshed }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      core.warning(`oauth post-hook: writeback returned ${response.status}: ${body}`);
      return;
    }
    core.info(`oauth post-hook: refreshed ${entry.secretName} persisted to Pullfrog`);
  } catch (err) {
    core.warning(`oauth post-hook: writeback failed — ${err}`);
  }
}

main().catch((err) => {
  core.warning(`oauth post-hook: unexpected error — ${err}`);
});
