// `pullfrog mcp` — a stdio MCP server exposing the PR event stream as a tool.
//
// this exists because agent harnesses do not consume streams, they consume
// calls that return. Claude Code can read a long-running process's stdout, but
// Codex and opencode have no equivalent affordance: Codex's `notify` fires only
// on agent-turn-complete and is one-way, and every opencode plugin hook is
// outbound. what all three DO share is MCP, so a bounded blocking tool is the
// one shape that works everywhere.
//
// the wait is capped below Codex's 60s default `tool_timeout_sec`, so this
// needs no per-harness timeout configuration to work out of the box.

// this must be imported first — it drops the JSON Schema dialect that some MCP
// clients reject on tool parameter schemas.
import "../mcp/arkConfig.ts";
import { type } from "arktype";
import { FastMCP } from "fastmcp";
import { isTerminal, resolveCursor, SERVER_POLL_WINDOW_MS, waitForPrEvents } from "./_prEvents.ts";
import { GH_TOKEN_HELP, tryGetGhToken, tryParseGitRemote } from "./_shared.ts";

/** ceiling on a single `pr_wait` call. Codex defaults `tool_timeout_sec` to 60,
 * so staying under that is what keeps this usable with no config anywhere. */
const MAX_WAIT_SECONDS = 50;

const PrWait = type({
  pr: type.number.describe("The pull request number to wait on"),
  "repo?": type.string.describe("Target repo as 'owner/repo'. Defaults to the current git remote."),
  "max_wait_seconds?": type.number.describe(
    `How long to block before returning empty. Default 25, maximum ${MAX_WAIT_SECONDS}.`
  ),
});

type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: Record<string, unknown>): ToolText => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const fail = (message: string): ToolText => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

function resolveTarget(repo: string | undefined): { owner: string; repo: string } | null {
  if (repo === undefined) return tryParseGitRemote();
  const match = repo.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** the published CLI version, in the semver shape FastMCP's type demands.
 * rebuilt from the matched groups so it narrows without a cast. */
function cliVersion(): `${number}.${number}.${number}` {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(process.env.CLI_VERSION ?? "");
  if (!parts) return "0.0.0";
  return `${Number(parts[1])}.${Number(parts[2])}.${Number(parts[3])}`;
}

export async function runCli(input: { args: string[]; prog: string; showHelp: boolean }) {
  if (input.showHelp || input.args.includes("--help") || input.args.includes("-h")) {
    console.log(`usage: ${input.prog} mcp\n`);
    console.log("run a stdio MCP server exposing this repo's PR activity as an agent tool.\n");
    console.log("register it with your harness rather than running it by hand:");
    console.log(`  claude mcp add pullfrog -- npx ${input.prog} mcp`);
    process.exit(0);
  }

  const server = new FastMCP({ name: "pullfrog", version: cliVersion() });

  server.addTool({
    name: "pr_wait",
    description:
      "Block until new activity lands on a GitHub pull request, then return it. " +
      "Covers new reviews, review comments, resolved/unresolved review threads, " +
      "top-level PR comments, PR state changes (opened/closed/merged/synchronized), " +
      "and completed check suites. Returns as soon as anything arrives, or an empty " +
      "`events` array if the wait elapsed quietly — call it again to keep waiting. " +
      "Reads a push feed of GitHub webhooks rather than polling the GitHub API, and " +
      "remembers its position between calls, so consecutive calls do not miss events " +
      "that landed in between. Example: `pr_wait({ pr: 42 })`.",
    parameters: PrWait,
    execute: async (params): Promise<ToolText> => {
      const token = tryGetGhToken();
      if (!token) return fail(GH_TOKEN_HELP);

      const target = resolveTarget(params.repo);
      if (!target) {
        return fail(
          "could not determine the repo — pass `repo` as 'owner/repo', or run the server " +
            "from a git checkout whose origin remote points at github."
        );
      }
      if (!Number.isInteger(params.pr) || params.pr <= 0) {
        return fail(`pr must be a positive integer, got ${params.pr}`);
      }

      const requested = params.max_wait_seconds ?? SERVER_POLL_WINDOW_MS / 1000;
      const maxWaitMs = Math.min(Math.max(requested, 1), MAX_WAIT_SECONDS) * 1000;
      const watched = { ...target, pr: params.pr };

      try {
        const cursor = await resolveCursor({ ...watched, token, since: undefined });
        const started = Date.now();
        const result = await waitForPrEvents({ ...watched, token, cursor, maxWaitMs });
        return ok({
          repo: `${target.owner}/${target.repo}`,
          pr: params.pr,
          waited_seconds: Math.round((Date.now() - started) / 1000),
          events: result.events,
        });
      } catch (error) {
        if (isTerminal(error)) return fail(error.message);
        throw error;
      }
    },
  });

  await server.start({ transportType: "stdio" });

  // `start` resolves as soon as the transport is listening, and `cli.ts` calls
  // process.exit the instant run() returns (the #1087 leaked-handle guard) —
  // which would kill the server before it answered a single tool call. hold the
  // command open until the harness closes our stdin, the conventional stdio-MCP
  // shutdown signal.
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
}
