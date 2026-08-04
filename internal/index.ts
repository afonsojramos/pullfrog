/**
 * Internal entrypoint for the root app.
 * Re-exports shared types, values, and utilities needed by the Next.js app.
 */

export type {
  AuthorPermission,
  AutoTier,
  EffortPosition,
  ModelAlias,
  ModelProvider,
  Payload,
  PayloadEvent,
  ProviderConfig,
  PushPermission,
  ShellPermission,
  ToolPermission,
  WriteablePayload,
  XrepoConfig,
} from "../external.ts";
export {
  AUTO_EFFICIENT,
  AUTO_INTELLIGENT,
  DEFAULT_EFFORT_POSITION,
  DEFAULT_PROXY_MODEL,
  defaultAutoTier,
  EFFORT_ALIASES,
  getAutoSelectHintModel,
  getModelEffortLevels,
  getModelEnvVars,
  getModelManagedCredentials,
  getModelProvider,
  getProviderDisplayName,
  isAutoTier,
  isCardGatedModel,
  isEffortPosition,
  isOssAllowedModel,
  modelAliases,
  modelHasStoredAuth,
  OSS_MODEL_ALLOWLIST,
  OSS_RECOMMENDED_MODEL,
  offeredRungs,
  parseEffortPosition,
  parseModel,
  providers,
  pullfrogMcpName,
  resolveAutoTier,
  resolveCliModel,
  resolveDisplayAlias,
  resolveModelRung,
  resolveModelSlug,
  resolveOpenRouterModel,
  resolveRung,
  rungLabel,
  rungPosition,
} from "../external.ts";
export type { Mode } from "../modes.ts";
export { modes } from "../modes.ts";
export { commercialPaywallBody } from "../utils/billingErrors.ts";
export type {
  BuildPullfrogFooterParams,
  WorkflowRunFooterInfo,
} from "../utils/buildPullfrogFooter.ts";
export {
  buildPullfrogFooter,
  PULLFROG_DIVIDER,
  stripExistingFooter,
} from "../utils/buildPullfrogFooter.ts";
export type { CodexAuthBody } from "../utils/codexOAuth.ts";
export {
  decodeJwtExpMs,
  OAuthInvalidGrantError,
  parseCodexAuthBody,
  refreshCodexAuthBody,
  stringifyCodexAuthBody,
} from "../utils/codexOAuth.ts";
export type { ResourceUsage, UsageSummary } from "../utils/github.ts";
export { isPullfrog } from "../utils/isPullfrog.ts";
export {
  isLeapingIntoActionCommentBody,
  LEAPING_INTO_ACTION_PREFIX,
} from "../utils/leapingComment.ts";
export { MAX_LEARNINGS_LENGTH, truncateAtLineBoundary } from "../utils/learningsTruncate.ts";
export type {
  CreateProgressCommentTarget,
  ProgressComment,
  ProgressCommentType,
} from "../utils/progressComment.ts";
export {
  createLeapingProgressComment,
  deleteProgressCommentApi,
  getProgressComment,
  updateProgressComment,
} from "../utils/progressComment.ts";
export type {
  RunStatusCheckConclusion,
  RunStatusCheckOctokit,
} from "../utils/runStatusCheck.ts";
export {
  APPROVAL_CHECK_NAME,
  createRunStatusCheck,
  finalizeRunStatusCheck,
  RUN_STATUS_CHECK_NAME,
  runStatusCheckNeedsFinalizing,
} from "../utils/runStatusCheck.ts";
export {
  isValidTimeString,
  parseTimeString,
  TIMEOUT_DISABLED,
} from "../utils/time.ts";
