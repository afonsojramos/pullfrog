/**
 * Pure-stdlib (fetch) xAI/Grok OAuth: device-code login + refresh.
 *
 * Lives here (not in a CLI module) so the Next.js server side can import it
 * via pullfrog/internal without dragging in node:child_process. Used by:
 *   - action/commands/auth.ts   (`pullfrog auth grok` device-code login)
 *   - action/utils/codexHome.ts (materialize into opencode's auth.json)
 *   - utils/xaiSecretRotation.ts (server-side rotation at run-context)
 *
 * We talk to xAI's OAuth endpoints directly rather than shelling out to the
 * Grok CLI the way `auth codex` shells out to `codex login`. The Grok CLI is
 * a curl|bash install that nothing else in the flow needs, and the device
 * grant is ~60 lines of fetch — requiring a second CLI to obtain a
 * credential opencode consumes natively would be gratuitous.
 *
 * See wiki/grok-auth.md.
 */

import { OAuthInvalidGrantError, parseOAuthErrorBody } from "./oauthShared.ts";

export interface XaiAuthBody {
  auth_mode: "grok";
  tokens: {
    access_token: string;
    refresh_token: string;
  };
  last_refresh?: string;
  /**
   * ISO timestamp of an `invalid_grant` rejection. xAI rotates the refresh
   * token on every use, so a rejection is PERMANENT until the user re-runs
   * `pullfrog auth grok`. Without the latch the server re-issues the same
   * doomed refresh on every run, each holding a Postgres row lock across an
   * external call — the failure mode measured for Codex in
   * [#1101](https://github.com/pullfrog/app/issues/1101). Cleared implicitly:
   * `pullfrog auth grok` and `PUT /api/runtime/secret` write a fresh blob
   * without it, which re-arms rotation.
   */
  refresh_rejected_at?: string;
}

/** Public Grok-CLI OAuth client. Identical to the `oidc_client_id` the Grok
 * CLI writes into its own `~/.grok/auth.json` and to opencode's XaiAuthPlugin
 * CLIENT_ID — one chain, so a token minted here refreshes anywhere. */
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** `api:access` is the scope that lets the subscription token authorize
 * api.x.ai — without it the credential logs in but cannot infer. */
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

/** xAI speaks RFC 6749 here: a spent or revoked refresh token answers
 * `400 {"error":"invalid_grant"}`. Measured against auth.x.ai with negative
 * controls — a bad `grant_type` answers `unsupported_grant_type` and an
 * unknown client answers `401 invalid_client`, neither of which says anything
 * about the token itself. */
function xaiChainIsDead(body: string): boolean {
  return parseOAuthErrorBody(body)?.error === "invalid_grant";
}

/** force one refresh round-trip against xAI. returns the rotated blob; does
 * NOT persist — the caller writes it back wherever the token lives.
 *
 * The 10s timeout matters server-side: `maybeRotateXaiSecret` holds a DB row
 * lock across this call, so the cap keeps us inside the enclosing transaction
 * budget and guarantees queued callers get a turn. Real latency is sub-second. */
export async function refreshXaiAuthBody(body: XaiAuthBody): Promise<XaiAuthBody> {
  const response = await fetch(XAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: body.tokens.refresh_token,
      client_id: XAI_OAUTH_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status >= 400 && response.status < 500) {
      throw new OAuthInvalidGrantError("Grok", response.status, text, xaiChainIsDead(text));
    }
    throw new Error(`Grok token refresh failed: ${response.status} ${text}`);
  }
  const tokens = (await response.json()) as OAuthTokenResponse;
  return {
    auth_mode: "grok",
    tokens: {
      access_token: tokens.access_token,
      // xAI rotates on every use, but tolerate a server that echoes nothing
      // rather than writing an empty refresh token that bricks the chain.
      refresh_token: tokens.refresh_token || body.tokens.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };
}

/** parse + validate a stored Grok blob. returns null on any shape mismatch —
 * caller treats null as "no grok auth". */
export function parseXaiAuthBody(raw: string): XaiAuthBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed as Record<string, unknown>;
  if (v.auth_mode !== "grok") return null;
  const tokens = v.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || t.access_token.length === 0) return null;
  if (typeof t.refresh_token !== "string" || t.refresh_token.length === 0) return null;
  return {
    auth_mode: "grok",
    ...(typeof v.refresh_rejected_at === "string"
      ? { refresh_rejected_at: v.refresh_rejected_at }
      : {}),
    tokens: { access_token: t.access_token, refresh_token: t.refresh_token },
    ...(typeof v.last_refresh === "string" ? { last_refresh: v.last_refresh } : {}),
  };
}

/** serialize to the canonical stored form. */
export function stringifyXaiAuthBody(body: XaiAuthBody): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

export interface XaiDeviceCode {
  deviceCode: string;
  userCode: string;
  /** pre-filled URL when xAI supplies one, else the bare verification URL. */
  verificationUrl: string;
  intervalMs: number;
  expiresAtMs: number;
}

/** RFC 8628 step 1: ask xAI for a device code. The user approves in a browser
 * on any device — no loopback callback server, so this works unchanged from a
 * container, an SSH session, or a locked-down workstation. */
export async function startXaiDeviceAuth(): Promise<XaiDeviceCode> {
  const response = await fetch(XAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Grok device authorization failed: ${response.status} ${text}`);
  }
  const body = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl:
      body.verification_uri_complete || body.verification_uri || "https://x.ai/device",
    intervalMs: Math.max((body.interval ?? 5) * 1000, 1_000),
    expiresAtMs: Date.now() + (body.expires_in ?? 300) * 1000,
  };
}

/** RFC 8628 step 2: long-poll the token endpoint until the user approves.
 * Honors the spec's `authorization_pending` / `slow_down` back-off. Resolves
 * with the minted chain, or throws on denial / expiry. */
export async function pollXaiDeviceAuth(device: XaiDeviceCode): Promise<XaiAuthBody> {
  let intervalMs = device.intervalMs;
  while (Date.now() < device.expiresAtMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch(XAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
        device_code: device.deviceCode,
        client_id: XAI_OAUTH_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const tokens = (await response.json()) as OAuthTokenResponse;
      return {
        auth_mode: "grok",
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        },
        last_refresh: new Date().toISOString(),
      };
    }
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("Grok sign-in was denied.");
    }
    if (body.error === "expired_token") break;
    throw new Error(`Grok device authorization failed: ${response.status} ${body.error ?? ""}`);
  }
  throw new Error("Grok sign-in timed out — re-run the command and approve the code sooner.");
}
