import arg from "arg";
import { z } from "zod";
import {
  type ConfigField,
  type ConfigValue,
  configChoices,
  configFields,
  configResponseSchema,
  configValueSchema,
} from "../configuration.ts";
import {
  configurationApi,
  confirmChange,
  readValueFile,
  resolveTarget,
  scopeArgs,
} from "./_configuration.ts";

const changeSchema = z.object({
  confirmationRequired: z.boolean(),
  before: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  after: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  autoMerge: z.boolean().optional(),
  target: z.string(),
  key: z.string(),
  warnings: z.array(z.string()),
});

function printHelp(prog: string) {
  console.log(`usage: ${prog} config <keys|describe|list|get|set|unset> [key] [value]

  keys [prefix]        list supported keys and accepted values (offline)
  describe <key>       describe a key, permissions and clearing behavior
  list                 list configured values, their source and write access
  get <key>            print a value; model and effort include inherited defaults
  set <key> <value>    change one setting
  unset <key>          clear an override or optional text

  --repo, -R OWNER/REPO   select a repository (default: GitHub origin)
  --org OWNER            select organization or personal-account defaults
  --file PATH            read text from a file; - reads stdin
  --yes                  acknowledge a consequential change
  --ack-auto-merge       explicitly acknowledge enabling autonomous merging
  -h, --help             show help

examples:
  ${prog} config keys review
  ${prog} config set enabled false --repo acme/api
  ${prog} config get model --org acme
  ${prog} config set instructions --file instructions.md`);
}

function parseValue(field: ConfigField, raw: string): ConfigValue {
  let value: ConfigValue = raw;
  if (["boolean", "toggle", "status"].includes(field.kind)) {
    if (raw !== "true" && raw !== "false") throw new Error("expected true or false");
    value = raw === "true";
  }
  if (field.kind === "effort" || field.kind === "usd") {
    if (!raw.trim()) throw new Error("expected a number");
    value = Number(raw);
  }
  const result = configValueSchema(field).safeParse(value);
  if (!result.success) throw new Error(`invalid ${field.key}: expected ${configChoices(field)}`);
  return result.data;
}

export async function runCli(input: { args: string[]; prog: string; showHelp?: boolean }) {
  const args = arg(
    { ...scopeArgs, "--file": String, "--yes": Boolean, "--ack-auto-merge": Boolean },
    { argv: input.args }
  );
  if (input.showHelp || args["--help"] || !args._.length) return printHelp(input.prog);
  const command = args._[0];
  if (args["--file"] !== undefined && command !== "set")
    throw new Error("--file is only supported by config set");
  const key = args._[1];
  const fields = configFields(args["--org"] !== undefined ? "org" : "repo");
  if (args["--org"] !== undefined && args["--repo"] !== undefined)
    throw new Error("choose --org or --repo, not both");
  if (command === "keys") {
    if (args._.length > 2) throw new Error("usage: config keys [prefix]");
    for (const field of fields.filter((field) => !key || field.key.startsWith(key))) {
      console.log(
        `${field.key.padEnd(29)} ${configChoices(field)}${field.nullable ? " (unset allowed)" : ""}`
      );
    }
    return;
  }
  const field = fields.find((field) => field.key === key);
  if (command !== "list" && !field)
    throw new Error("unknown or missing key; run pullfrog config keys");
  if (command === "describe" && field) {
    if (args._.length !== 2) throw new Error("usage: config describe KEY");
    console.log(
      `${field.key}\n${field.description}\nvalues: ${configChoices(field)}\nunset: ${field.nullable ? "allowed" : "not allowed"}\nwrite access: ${args["--org"] !== undefined ? (field.privileged ? "org owner" : "org member") : field.privileged ? "repo admin" : "repo write"}`
    );
    return;
  }
  const target = resolveTarget({ org: args["--org"], repo: args["--repo"] });
  if (command === "list" || command === "get") {
    if (args._.length !== (command === "list" ? 1 : 2))
      throw new Error(`usage: config ${command}${command === "get" ? " KEY" : ""}`);
    const data = configResponseSchema.parse(await configurationApi({ target, path: "config" }));
    if (command === "get") {
      const entry = data.entries.find((entry) => entry.key === key);
      if (!entry) throw new Error("permission required to read this setting");
      if (entry.source === "unavailable")
        throw new Error("the inherited org default is not visible to this GitHub identity");
      console.log(entry.value ?? (key === "model" ? "auto" : "unset"));
    } else {
      console.log(`${data.target}\n`);
      for (const entry of data.entries)
        console.log(
          `${entry.key.padEnd(29)} ${JSON.stringify(entry.value ?? "unset")}  [${entry.source}${entry.writable ? "" : ", read-only"}]`
        );
      for (const warning of data.warnings) console.error(warning);
    }
    return;
  }
  if ((command !== "set" && command !== "unset") || !field)
    throw new Error("expected keys, describe, list, get, set or unset");
  const file = args["--file"];
  const expectedArgs = command === "unset" || file !== undefined ? 2 : 3;
  if (args._.length !== expectedArgs || (command === "unset" && file !== undefined))
    throw new Error(
      `usage: config ${command} KEY${command === "set" ? " VALUE (or --file PATH)" : ""}`
    );
  if (file !== undefined && field.kind !== "text" && field.kind !== "prompt")
    throw new Error("--file is only supported for text settings");
  if (command === "unset" && !field.nullable)
    throw new Error("this key cannot be unset; set an explicit value");
  const value =
    command === "unset"
      ? null
      : parseValue(field, file === undefined ? args._[2] : await readValueFile(file));
  let result = changeSchema.parse(
    await configurationApi({ target, path: "config", method: "PATCH", body: { key, value } })
  );
  if (result.confirmationRequired) {
    await confirmChange({
      message: `${result.target}: ${key}: ${JSON.stringify(result.before)} → ${JSON.stringify(result.after)}`,
      yes: args["--yes"] === true,
      autoMerge: result.autoMerge === true,
      ackAutoMerge: args["--ack-auto-merge"] === true,
    });
    result = changeSchema.parse(
      await configurationApi({
        target,
        path: "config",
        method: "PATCH",
        body: {
          key,
          value,
          confirmed: true,
          expectedValue: result.before,
          ackAutoMerge: result.autoMerge === true || args["--ack-auto-merge"] === true,
        },
      })
    );
    if (result.confirmationRequired)
      throw new Error("setting changed while confirming; inspect it and retry");
  }
  console.log(`${result.target}: ${key} ${command === "unset" ? "unset" : "updated"}`);
  for (const warning of result.warnings) console.error(warning);
}
