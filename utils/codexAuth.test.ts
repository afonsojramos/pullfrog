import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSpawnTarget } from "./codexAuth.ts";

const isWindows = process.platform === "win32";

function shimDir(): string {
  return mkdtempSync(join(tmpdir(), "codex-shim-"));
}

/** the exact shape `npm i -g @openai/codex` leaves on Windows: a `.cmd` shim
 * around a JS entry point, and no `codex.exe` anywhere on PATH. */
function writeCmdShim(directory: string, name: string): string {
  const shim = join(directory, `${name}.cmd`);
  writeFileSync(shim, "@echo off\r\necho codex-cli 0.152.0\r\n");
  return shim;
}

function writePosixShim(directory: string, name: string): string {
  const shim = join(directory, name);
  writeFileSync(shim, "#!/bin/sh\necho codex-cli 0.152.0\n");
  chmodSync(shim, 0o755);
  return shim;
}

function runTarget(params: {
  target: { file: string; args: string[]; wrapped: boolean };
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.target.file, params.target.args, {
      env: params.env,
      windowsVerbatimArguments: params.target.wrapped,
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => resolve(output.trim()));
  });
}

describe("resolveSpawnTarget", () => {
  it.skipIf(isWindows)("keeps the bare name on POSIX, where spawn already resolves it", () => {
    const target = resolveSpawnTarget({ command: "codex", args: ["login"], env: { PATH: "" } });
    expect(target).toEqual({ file: "codex", args: ["login"], wrapped: false });
  });

  it.runIf(isWindows)("routes a .cmd shim through the command processor", () => {
    const directory = shimDir();
    const shim = writeCmdShim(directory, "codex");
    const target = resolveSpawnTarget({
      command: "codex",
      args: ["login", "--device-auth"],
      env: { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    expect(target?.wrapped).toBe(true);
    expect(target?.file.toLowerCase()).toContain("cmd.exe");
    // absolute, not the bare name: System32 is on the ambient PATH, so a
    // regression to `"cmd.exe"` would spawn fine here and hide itself.
    expect(isAbsolute(target?.file ?? "")).toBe(true);
    // the outer pair is what `cmd /s` strips; the inner one survives a space.
    expect(target?.args.at(-1)).toBe(`""${shim}" login --device-auth"`);
  });

  it.runIf(isWindows)("spawns a real .exe directly", () => {
    const directory = shimDir();
    const exe = join(directory, "codex.exe");
    writeFileSync(exe, "");
    const target = resolveSpawnTarget({
      command: "codex",
      args: ["login"],
      env: { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    expect(target).toEqual({ file: exe, args: ["login"], wrapped: false });
  });

  it.runIf(isWindows)("prefers .exe over a .cmd shim in the same directory", () => {
    const directory = shimDir();
    writeCmdShim(directory, "codex");
    const exe = join(directory, "codex.exe");
    writeFileSync(exe, "");
    const target = resolveSpawnTarget({
      command: "codex",
      args: [],
      env: { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    expect(target?.file).toBe(exe);
  });

  it.runIf(isWindows)("returns null when nothing on PATH matches", () => {
    const target = resolveSpawnTarget({
      command: "codex",
      args: [],
      env: { PATH: shimDir(), PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    expect(target).toBeNull();
  });
});

describe("resolved target is actually spawnable", () => {
  /** the regression itself: on Windows a bare `spawn("codex")` is ENOENT
   * against a `.cmd` shim, so resolving first is what makes the launch work. */
  it("runs a shim that a bare spawn cannot find", async () => {
    const directory = shimDir();
    const name = "pullfrog-codex-probe";
    if (isWindows) writeCmdShim(directory, name);
    else writePosixShim(directory, name);

    // prepended, not replacing — that is where npm's global bin dir sits, and
    // a narrowed PATH would hide `cmd.exe` from the wrapper branch.
    const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` };
    const target = resolveSpawnTarget({ command: name, args: [], env });
    expect(target).not.toBeNull();
    if (!target) return;

    expect(await runTarget({ target, env })).toBe("codex-cli 0.152.0");
  });

  /** review claim: the `cmd.exe` invocation breaks when the shim path contains
   * a space, which every `C:\Users\First Last` profile does. `/s` strips the
   * outer quote pair only when the string both starts and ends with one, so
   * this asserts the real quoting rather than reasoning about it. */
  it.runIf(isWindows)("runs a shim whose path contains spaces", async () => {
    const directory = join(shimDir(), "dir with spaces");
    mkdirSync(directory);
    const name = "pullfrog codex probe";
    writeCmdShim(directory, name);

    const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` };
    const target = resolveSpawnTarget({ command: name, args: [], env });
    expect(target?.wrapped).toBe(true);
    if (!target) return;

    expect(await runTarget({ target, env })).toBe("codex-cli 0.152.0");
  });

  /** review claim: Windows spells the variable `Path`, so reading `env.PATH`
   * off a plain object misses it. `process.env` itself is case-insensitive on
   * Windows; a spread copy of it is not. */
  it.runIf(isWindows)("resolves against a Path-cased environment", () => {
    const directory = shimDir();
    writeCmdShim(directory, "codex");
    const target = resolveSpawnTarget({
      command: "codex",
      args: [],
      env: { Path: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    });
    expect(target).not.toBeNull();
  });

  it.runIf(isWindows)("proves the bare-name spawn this fix replaces fails", async () => {
    const directory = shimDir();
    const name = "pullfrog-codex-probe-bare";
    writeCmdShim(directory, name);
    const failure = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const child = spawn(name, [], { env: { ...process.env, PATH: directory } });
      child.on("error", resolve);
    });
    expect(failure.code).toBe("ENOENT");
  });
});
