import { existsSync } from "node:fs";

export const isGitHubActions = !!process.env.GITHUB_ACTIONS;

// detect if running inside Docker container (CI tests run in Docker with host env vars)
export const isInsideDocker = existsSync("/.dockerenv");
