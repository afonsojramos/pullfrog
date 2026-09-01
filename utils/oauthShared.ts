/**
 * Provider-agnostic OAuth primitives shared by the Codex and Grok chains.
 * Pure stdlib (Buffer) so both the action runtime and the Next.js server can
 * import it via pullfrog/internal.
 *
 * Both chains mint JWT access tokens whose `exp` we read as a freshness hint,
 * and both rotate their refresh token on every use — so both need the same
 * "the provider rejected this permanently" signal.
 */

/**
 * Thrown when an OAuth provider rejects a refresh token (4xx).
 *
 * `chainIsDead` is decided by the CALLER, because the two providers we talk to
 * disagree about how to say it and only the caller knows its own dialect:
 * xAI answers RFC 6749 (`{"error":"invalid_grant"}`) while OpenAI nests an
 * object and discriminates on `error.code` (`token_expired`). A rejection we
 * cannot classify — a CDN error page in front of the token endpoint, say — is
 * NOT dead: latching there would retire every customer's working credential
 * over a transient edge event.
 */
export class OAuthInvalidGrantError extends Error {
  public readonly status: number;
  /** whether the provider said this refresh chain is permanently unusable, so
   * the rotation core may latch it out of use until the user re-mints. */
  public readonly chainIsDead: boolean;
  constructor(provider: string, status: number, body: string, chainIsDead: boolean) {
    super(`${provider} token refresh failed: ${status} ${body}`);
    this.name = "OAuthInvalidGrantError";
    this.status = status;
    this.chainIsDead = chainIsDead;
  }
}

/** parse a token-endpoint error body, or null when it is not a JSON object.
 * Each provider's refresh reads its own discriminator out of the result. */
export function parseOAuthErrorBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // non-JSON body: unclassifiable, so the caller treats it as retryable.
  }
  return null;
}

/** decode a JWT payload's `exp` claim and return it in ms since epoch.
 * returns null if the token isn't a parseable JWT or has no `exp` claim —
 * caller falls back to "treat as expired".
 *
 * We don't verify the signature (we'd need the issuer's JWKS); we're only
 * using the claim as a freshness hint. The real auth check happens at the
 * provider when the token is used, so trusting a forged JWT here would just
 * delay the inevitable 401. No security boundary at this decode step. */
export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let payload: { exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  return payload.exp * 1000;
}
