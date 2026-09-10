import { z } from "zod";

export type ConfigScope = "org" | "repo";
export type ConfigValue = string | number | boolean | null;

export interface ConfigField {
  key: string;
  field: string;
  kind:
    | "text"
    | "model"
    | "effort"
    | "boolean"
    | "toggle"
    | "permission"
    | "enum"
    | "usd"
    | "status"
    | "prompt";
  description: string;
  nullable?: boolean;
  privileged?: boolean;
  choices?: readonly string[];
  min?: number;
  max?: number;
}

const defaults: ConfigField[] = [
  {
    key: "model",
    field: "model",
    kind: "model",
    nullable: true,
    description: "default provider/model; unset to inherit",
  },
  {
    key: "effort",
    field: "effort",
    kind: "effort",
    nullable: true,
    description: "reasoning effort from 0 to 1; unset to inherit",
  },
  {
    key: "instructions",
    field: "baseInstructions",
    kind: "text",
    nullable: true,
    description: "standing instructions for every run",
  },
];

export const repoConfigFields: ConfigField[] = [
  {
    key: "enabled",
    field: "status",
    kind: "status",
    description: "enable or disable Pullfrog on this repository; does not install a workflow",
  },
  ...defaults,
  {
    key: "progress-comments",
    field: "progressComments",
    kind: "toggle",
    description: "temporary progress comments during a run",
  },
  {
    key: "oss",
    field: "ossProgramEnabled",
    kind: "boolean",
    privileged: true,
    description: "use an existing OSS funding grant; does not enroll this repo",
  },
  {
    key: "push",
    field: "push",
    kind: "permission",
    privileged: true,
    description: "git push permission",
  },
  {
    key: "shell",
    field: "shell",
    kind: "permission",
    privileged: true,
    description: "agent shell permission and isolation",
  },
  {
    key: "env-allowlist",
    field: "envAllowlist",
    kind: "text",
    nullable: true,
    privileged: true,
    description: "environment variable names exposed to shell commands, one per line",
  },
  {
    key: "signed-commits",
    field: "signedCommits",
    kind: "toggle",
    privileged: true,
    description: "sign commits when Pro or grandfathered access permits",
  },
  {
    key: "auto-merge",
    field: "autoMergeEnabled",
    kind: "toggle",
    privileged: true,
    description: "allow autonomous merging, subject to runtime safety gates",
  },
  {
    key: "hooks.setup",
    field: "setupScript",
    kind: "text",
    nullable: true,
    description: "script run at setup",
  },
  {
    key: "hooks.post-checkout",
    field: "postCheckoutScript",
    kind: "text",
    nullable: true,
    description: "script run after checkout",
  },
  {
    key: "hooks.pre-push",
    field: "prepushScript",
    kind: "text",
    nullable: true,
    description: "script run before pushing",
  },
  {
    key: "hooks.stop",
    field: "stopScript",
    kind: "text",
    nullable: true,
    description: "script run at agent stop",
  },
  {
    key: "prompts.review",
    field: "Review",
    kind: "prompt",
    nullable: true,
    description: "additional instructions for reviews",
  },
  {
    key: "prompts.build",
    field: "Build",
    kind: "prompt",
    nullable: true,
    description: "additional instructions for implementation",
  },
  {
    key: "prompts.plan",
    field: "Plan",
    kind: "prompt",
    nullable: true,
    description: "additional instructions for planning",
  },
  { key: "mention.enabled", field: "mention", kind: "toggle", description: "respond to mentions" },
  {
    key: "mention.instructions",
    field: "mentionInstructions",
    kind: "text",
    nullable: true,
    description: "instructions for mention-triggered runs",
  },
  {
    key: "mention.non-collaborators",
    field: "mentionAllowNonCollaborator",
    kind: "toggle",
    description: "allow mentions from non-collaborators",
  },
  {
    key: "review.mode",
    field: "prCreated",
    kind: "enum",
    choices: ["none", "links", "agent"],
    description: "behavior when a PR is opened",
  },
  {
    key: "review.non-collaborators",
    field: "prCreatedAllowNonCollaborator",
    kind: "toggle",
    description: "review PRs from non-collaborators",
  },
  {
    key: "review.re-review",
    field: "prReReview",
    kind: "toggle",
    description: "re-review PRs after updates",
  },
  {
    key: "review.approve",
    field: "prApproveEnabled",
    kind: "toggle",
    description: "allow approving reviews",
  },
  {
    key: "review.drafts",
    field: "prCreatedReviewDrafts",
    kind: "toggle",
    description: "review draft PRs",
  },
  {
    key: "review.own-prs",
    field: "reviewOwnPrs",
    kind: "toggle",
    description: "review Pullfrog-authored PRs",
  },
  {
    key: "review.status-check",
    field: "statusChecks",
    kind: "toggle",
    description: "publish the run status check",
  },
  {
    key: "review.approval-check",
    field: "approvalCheck",
    kind: "toggle",
    description: "publish the approval verdict check",
  },
  {
    key: "issue.mode",
    field: "issueCreated",
    kind: "enum",
    choices: ["none", "links", "plan", "build", "custom"],
    description: "behavior when an issue is opened",
  },
  {
    key: "issue.instructions",
    field: "issueCreatedInstructions",
    kind: "text",
    nullable: true,
    description: "instructions for new issues",
  },
  {
    key: "issue.non-collaborators",
    field: "issueCreatedAllowNonCollaborator",
    kind: "toggle",
    description: "handle issues from non-collaborators",
  },
  {
    key: "label.enabled",
    field: "autoLabelIssues",
    kind: "toggle",
    description: "automatically label issues",
  },
  {
    key: "label.instructions",
    field: "autoLabelIssuesInstructions",
    kind: "text",
    nullable: true,
    description: "instructions for issue labeling",
  },
  {
    key: "address-reviews.enabled",
    field: "codingAddressReviews",
    kind: "toggle",
    description: "address review feedback",
  },
  {
    key: "fix-ci.own-prs",
    field: "codingAutoFixCiFailuresSelf",
    kind: "toggle",
    description: "fix CI on Pullfrog-authored PRs",
  },
  {
    key: "fix-ci.reviewed-prs",
    field: "codingAutoFixCiFailuresReview",
    kind: "toggle",
    description: "fix CI on reviewed PRs",
  },
];

export const orgConfigFields: ConfigField[] = [
  ...defaults.map((field) => ({
    ...field,
    field:
      field.key === "model"
        ? "defaultModel"
        : field.key === "effort"
          ? "defaultEffort"
          : field.field,
  })),
  {
    key: "xrepo.brief",
    field: "xrepoBrief",
    kind: "text",
    nullable: true,
    description: "instructions for cross-repository work",
  },
  {
    key: "billing.mode",
    field: "modelAccessMode",
    kind: "enum",
    choices: ["byok", "router"],
    privileged: true,
    description: "provider credentials or Pullfrog Router",
  },
  {
    key: "billing.auto-reload",
    field: "autoReloadEnabled",
    kind: "boolean",
    privileged: true,
    description: "automatically charge for Router credit reloads",
  },
  {
    key: "billing.reload-threshold-usd",
    field: "autoReloadThresholdCents",
    kind: "usd",
    min: 5,
    max: 10000,
    privileged: true,
    description: "balance below which automatic reloads occur (USD)",
  },
  {
    key: "billing.reload-amount-usd",
    field: "autoReloadAmountCents",
    kind: "usd",
    min: 10,
    max: 100000,
    privileged: true,
    description: "amount added per automatic reload (USD)",
  },
  {
    key: "billing.monthly-limit-usd",
    field: "routerMonthlyLimitCents",
    kind: "usd",
    min: 10,
    max: 1000000,
    nullable: true,
    privileged: true,
    description: "monthly automatic top-up ceiling (USD); unset for unlimited",
  },
  {
    key: "billing.limit-mode",
    field: "routerLimitMode",
    kind: "enum",
    choices: ["hard_cap", "alert_only"],
    privileged: true,
    description: "stop automatic top-ups at the cap or only alert",
  },
];

export function configFields(scope: ConfigScope): ConfigField[] {
  return scope === "org" ? orgConfigFields : repoConfigFields;
}

export function configChoices(field: ConfigField): string {
  if (field.kind === "permission") return "disabled | restricted | enabled";
  if (["boolean", "toggle", "status"].includes(field.kind)) return "true | false";
  if (field.choices) return field.choices.join(" | ");
  if (field.kind === "usd") return `${field.min}..${field.max} USD`;
  if (field.kind === "effort") return "0..1";
  return field.kind === "model" ? "provider/model" : "text";
}

export function configValueSchema(field: ConfigField) {
  let schema: z.ZodType<ConfigValue>;
  switch (field.kind) {
    case "boolean":
    case "toggle":
    case "status":
      schema = z.boolean();
      break;
    case "effort":
      schema = z.number().min(0).max(1);
      break;
    case "usd":
      schema = z
        .number()
        .int()
        .min(field.min ?? 0)
        .max(field.max ?? Infinity);
      break;
    case "permission":
      schema = z.enum(["disabled", "restricted", "enabled"]);
      break;
    case "enum":
      schema = z
        .string()
        .refine((v) => field.choices?.includes(v), `expected ${configChoices(field)}`);
      break;
    case "model":
      schema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "expected provider/model");
      break;
    case "text":
    case "prompt":
      schema = z.string().max(100000);
      break;
    default:
      field.kind satisfies never;
      throw new Error("unknown config kind");
  }
  return field.nullable ? schema.nullable() : schema;
}

export const configEntrySchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  source: z.enum(["repo", "org", "default", "unavailable"]),
  writable: z.boolean(),
});
export const configResponseSchema = z.object({
  target: z.string(),
  entries: z.array(configEntrySchema),
  warnings: z.array(z.string()),
});
