import { type } from "arktype";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

const SearchIssues = type({
  terms: type.string
    .matching(/^[\p{L}\p{N}_./-]+$/u)
    .atMostLength(40)
    .array()
    .atLeastLength(1)
    .atMostLength(5)
    .describe("1-5 keywords from the issue; no GitHub qualifiers or query operators"),
});

export function SearchIssuesTool(ctx: ToolContext) {
  return tool({
    name: "search_issues",
    description:
      "Find open or closed issues in this repository by keyword. Inspect promising matches with get_issue before deciding whether they are duplicates or related. Results are bounded, not an exhaustive duplicate check.",
    parameters: SearchIssues,
    execute: execute(async (params) => {
      const repoPath = `/repos/${ctx.repo.owner}/${ctx.repo.name}`.toLowerCase();
      const terms = params.terms.map((term) => `"${term}"`).join(" ");
      const response = await ctx.octokit.rest.search.issuesAndPullRequests({
        q: `repo:${ctx.repo.owner}/${ctx.repo.name} is:issue ${terms}`,
        per_page: 20,
      });
      return {
        incomplete: response.data.incomplete_results || response.data.total_count > 20,
        issues: response.data.items
          .filter(
            (issue) =>
              new URL(issue.repository_url).pathname.toLowerCase() === repoPath &&
              !issue.pull_request &&
              issue.number !== ctx.payload.event.issue_number
          )
          .map((issue) => ({
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            state: issue.state,
          })),
      };
    }),
  });
}
