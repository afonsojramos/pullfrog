/**
 * emits a JSON array of { slug, agent, name } entries for one of two CI matrix
 * jobs. `agent` mirrors the harness the runtime would pick in production
 * (anthropic/* → claude, everything else → opencode).
 *
 * MODE=aliases (default) — every alias. consumed by `models-live`, which runs
 *   the cheap top-level CLI smoke per alias (`action/test/model-smoke.ts`) to
 *   validate resolution + auth.
 *
 * MODE=flagships — one standard-tier model per provider. consumed by
 *   `providers-live`, which runs the full harness smoke
 *   (`pnpm runtest smoke <agent>`) to validate provider-class tool-calling
 *   (e.g. Gemini schema sanitizer, OpenAI tool-call format). flagship slugs
 *   live in `providers.ts`.
 *
 * Every keyed alias is smoked — including `openrouter/*` and keyed `opencode/*`
 * passthroughs. They look like routing-layer wrappers but each one is a
 * distinct catalog entry on models.dev (under the `openrouter` / `opencode`
 * provider sections) that can drift independently of the upstream provider
 * mirror — testing the direct google entry tells you nothing about whether
 * the openrouter mirror has the same model id. The only entries pruned are
 * routing slugs (bedrock/byok) whose `resolve` is a sentinel that picks the
 * actual model id from a per-run env var.
 *
 * usage:
 *   node action/test/list-aliases.ts
 *   MODE=flagships node action/test/list-aliases.ts
 *
 * NOTE: the CI matrix (with MATRIX_FILTER scoping) lives in `matrix.ts`,
 * which calls into this file. raw invocation here emits the full list.
 */
import { modelAliases } from "../models.ts";
import { providers } from "./providers.ts";

export type MatrixEntry = {
  slug: string;
  agent: string;
  name: string;
};

function toMatrixEntry(alias: (typeof modelAliases)[number]): MatrixEntry {
  return {
    slug: alias.slug,
    agent: alias.slug.startsWith("anthropic/") ? "claude" : "opencode",
    // readable display name (GHA renders slashes awkwardly in matrix job titles)
    name: alias.slug.replace("/", "-"),
  };
}

const aliasBySlug = new Map(modelAliases.map((a) => [a.slug, a]));

/** providers CI holds no credential for — see `ProviderEntry.noCiCredential`. */
const uncredentialedProviders = new Set(
  providers.filter((p) => p.noCiCredential).map((p) => p.name)
);

export function buildAliasMatrix(): MatrixEntry[] {
  return modelAliases
    .filter((alias) => {
      // routing slugs (bedrock/byok) need a per-run env var to pick the actual
      // model — there's no generic smoke test.
      if (alias.routing) return false;
      // no key in CI, so every cell would fail on auth rather than on anything
      // the smoke is asking about.
      if (uncredentialedProviders.has(alias.provider)) return false;
      return true;
    })
    .map(toMatrixEntry);
}

export function buildFlagshipMatrix(): MatrixEntry[] {
  return providers
    .filter((p) => !p.noCiCredential)
    .map((p) => {
      const alias = aliasBySlug.get(p.flagship);
      if (!alias) {
        throw new Error(
          `list-aliases: flagship "${p.flagship}" missing from modelAliases — update providers.ts`
        );
      }
      return alias;
    })
    .map(toMatrixEntry);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.env.MODE === "flagships" ? "flagships" : "aliases";
  const matrix = mode === "flagships" ? buildFlagshipMatrix() : buildAliasMatrix();
  process.stdout.write(JSON.stringify(matrix));
}
