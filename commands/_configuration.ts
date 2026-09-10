import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { GH_TOKEN_HELP, pullfrogApi, tryGetGhToken, tryParseGitRemote } from "./_shared.ts";

export interface CliTarget {
  owner: string;
  repo: string | undefined;
}

export const scopeArgs = {
  "--org": String,
  "--repo": String,
  "-R": "--repo",
  "--help": Boolean,
  "-h": "--help",
};

export function resolveTarget(input: {
  org: string | undefined;
  repo: string | undefined;
}): CliTarget {
  if (input.org !== undefined && input.repo !== undefined)
    throw new Error("choose --org or --repo, not both");
  if (input.org !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(input.org)) throw new Error("expected --org OWNER");
    return { owner: input.org, repo: undefined };
  }
  if (input.repo !== undefined) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9_.-]+)$/.exec(input.repo);
    if (!match) throw new Error("expected --repo OWNER/REPO");
    return { owner: match[1], repo: match[2] };
  }
  const remote = tryParseGitRemote();
  if (!remote) throw new Error("no GitHub origin; specify --repo OWNER/REPO or --org OWNER");
  return remote;
}

export function targetName(target: CliTarget): string {
  return target.repo ? `${target.owner}/${target.repo}` : target.owner;
}

export async function configurationApi(input: {
  target: CliTarget;
  path: string;
  method?: string;
  body?: object;
  token?: string;
}) {
  const token = input.token ?? tryGetGhToken();
  if (!token) throw new Error(GH_TOKEN_HELP);
  const query = new URLSearchParams({ owner: input.target.owner });
  if (input.target.repo) query.set("repo", input.target.repo);
  const response = await pullfrogApi({
    path: `/api/cli/${input.path}?${query}`,
    token,
    method: input.method,
    body: input.body,
  });
  const body: unknown = response.data;
  if (!response.ok) {
    const confirmation = z.object({ confirmationRequired: z.literal(true) }).safeParse(body);
    if (response.status === 409 && confirmation.success) return body;
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(error.success ? error.data.error : `request failed (${response.status})`);
  }
  return body;
}

export async function readValueFile(file: string): Promise<string> {
  if (file !== "-") return readFile(file, "utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk.toString();
  return value;
}

export async function confirmChange(input: {
  message: string;
  yes: boolean;
  autoMerge?: boolean;
  ackAutoMerge?: boolean;
}) {
  console.error(input.message);
  if (input.autoMerge && !input.ackAutoMerge) {
    if (!process.stdin.isTTY || !process.stderr.isTTY)
      throw new Error("enabling auto-merge requires --yes --ack-auto-merge without a terminal");
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      if ((await prompt.question("type MERGE to enable autonomous merging: ")) !== "MERGE")
        throw new Error("canceled; nothing changed");
    } finally {
      prompt.close();
    }
    return;
  }
  if (input.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error("this change requires --yes without a terminal");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!/^y(es)?$/i.test((await prompt.question("continue? [y/N] ")).trim()))
      throw new Error("canceled; nothing changed");
  } finally {
    prompt.close();
  }
}
