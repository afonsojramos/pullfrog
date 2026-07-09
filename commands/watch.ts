// `pullfrog watch <owner>/<repo> --pr <N>` — subscribe to a PR's activity and
// emit one structured JSON line per new review / comment / inline review thread
// / PR state change / check-suite completion, WITHOUT polling GitHub. the server
// fans these out from the webhook pipeline it already receives, so latency is
// sub-second and there is zero GitHub API spend.
//
// transport is cursor-based long-poll: each request holds open on the server
// until new events land (or a short window elapses), then the client
// immediately re-requests with the returned cursor. designed to feed Claude
// Code's Monitor tool via its line-per-event stdout source.

import arg from "arg";
import pc from "picocolors";
import * as yes from "../yes/index.ts";
import { bail, getGhToken, PULLFROG_API_URL, parseGitRemote } from "./_shared.ts";

type StreamEvent = {
  cursor: string;
  repo: string;
  pr: number;
  kind: string;
  createdAt: string;
  data: Record<string, unknown>;
};

type PollResult = { cursor: string; events: StreamEvent[] };

// per-request ceiling — must exceed the server long-poll window (25s) so the
// held connection returns normally rather than aborting client-side.
const REQUEST_TIMEOUT_MS = 35_000;

function parseWatchArgs(args: string[]) {
  return arg(
    {
      "--pr": Number,
      "--pretty": Boolean,
      "--since": String,
      "--help": Boolean,
      "-h": "--help",
      "-p": "--pretty",
    },
    { argv: args }
  );
}

function printUsage(prog: string, stream: typeof console.log): void {
  stream(`usage: ${prog} watch [<owner>/<repo>] --pr <number> [options]\n`);
  stream("subscribe to a PR's activity and print one JSON line per event.\n");
  stream("arguments:");
  stream("  <owner>/<repo>   target repo (defaults to the current git remote)");
  stream("");
  stream("options:");
  stream("  --pr <number>    pull request number to watch (required)");
  stream("  --since <cursor> resume from a cursor emitted by a prior event");
  stream("  -p, --pretty     human-readable output instead of JSON lines");
  stream("  -h, --help       show help");
}

function resolveRepo(positional: string | undefined): { owner: string; repo: string } {
  if (!positional) return parseGitRemote();
  const match = positional.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) bail(`invalid repo "${positional}" — expected <owner>/<repo>`);
  return { owner: match[1], repo: match[2] };
}

async function pollOnce(ctx: {
  owner: string;
  repo: string;
  pr: number;
  token: string;
  cursor: string | undefined;
}): Promise<PollResult> {
  const params = new URLSearchParams({
    owner: ctx.owner,
    repo: ctx.repo,
    pr: String(ctx.pr),
  });
  if (ctx.cursor !== undefined) params.set("since", ctx.cursor);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${PULLFROG_API_URL}/api/cli/pr-events?${params}`, {
      headers: { authorization: `Bearer ${ctx.token}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      bail("invalid or expired github token — run `gh auth login`.");
    }
    if (response.status === 404) {
      bail(`repository ${ctx.owner}/${ctx.repo} not found or Pullfrog not installed on it.`);
    }
    if (!response.ok) {
      throw new Error(`pr-events returned ${response.status}`);
    }
    return (await response.json()) as PollResult;
  } finally {
    clearTimeout(timeout);
  }
}

function formatPretty(event: StreamEvent): string {
  const time = new Date(event.createdAt).toLocaleTimeString();
  const action = typeof event.data.action === "string" ? event.data.action : "";
  const actor =
    typeof event.data.author === "string"
      ? event.data.author
      : typeof event.data.reviewer === "string"
        ? event.data.reviewer
        : "";
  const detail = [action, actor && pc.dim(`by ${actor}`)].filter(Boolean).join(" ");
  return `${pc.dim(time)} ${pc.cyan(event.kind)} ${pc.bold(`#${event.pr}`)} ${detail}`.trimEnd();
}

export async function runCli(input: { args: string[]; prog: string; showHelp: boolean }) {
  let parsed: ReturnType<typeof parseWatchArgs>;
  try {
    parsed = parseWatchArgs(input.args);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n`);
    printUsage(input.prog, console.error);
    process.exit(1);
  }

  if (input.showHelp || parsed["--help"]) {
    printUsage(input.prog, console.log);
    process.exit(0);
  }

  const target = resolveRepo(parsed._[0]);
  const pr = parsed["--pr"];
  if (pr === undefined || !Number.isInteger(pr) || pr <= 0) {
    bail("--pr <number> is required");
  }

  const token = getGhToken();
  const pretty = parsed["--pretty"] === true;
  let cursor = parsed["--since"];

  const poll = yes.op(pollOnce, {
    name: "pr-events poll",
    retries: [1000, 2000, 5000, 10_000, 15_000],
  });

  // daemon loop — the loop is the whole command. `yes.op` smooths transient
  // network blips within a cycle; terminal auth/not-found errors exit via bail
  // inside pollOnce. a longer outage that exhausts the op's retries must NOT
  // kill the watcher, so we back off and keep going rather than crash.
  for (;;) {
    try {
      const result = await poll({ owner: target.owner, repo: target.repo, pr, token, cursor });
      cursor = result.cursor;
      for (const event of result.events) {
        process.stdout.write(pretty ? `${formatPretty(event)}\n` : `${JSON.stringify(event)}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(pc.dim(`watch: ${message} — retrying in 30s`));
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}
