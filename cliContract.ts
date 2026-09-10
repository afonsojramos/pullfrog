import packageJson from "./package.json" with { type: "json" };

// bump cliContractVersion only for breaking CLI API changes, not every release.
export const CLI_CONTRACT_VERSION = packageJson.cliContractVersion;
export const CLI_CONTRACT_HEADER = "x-pullfrog-cli-contract";
export const CLI_UPGRADE_MESSAGE =
  "this CLI is incompatible with the Pullfrog API. upgrade with `npm install --global pullfrog@latest` " +
  "or run `npx pullfrog@latest <command>`. if already up to date, retry after the server deployment completes.";

export class CliContractError extends Error {}
