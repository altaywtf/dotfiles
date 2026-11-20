#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join, resolve } from "node:path";
import { CommandRunner } from "../../lib/command.ts";
import type { CommandResult } from "../../lib/command.ts";
import { requirePrefixOwner } from "../../homebrew/homebrew.ts";
import { CliFailure, fail, runMain } from "../../lib/program.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const defaultPinPath = join(repoRoot, "chezmoi/.chezmoidata/xcode.json");
const usage = `Usage:
  bootstrap/darwin/xcode.ts
  bootstrap/darwin/xcode.ts --check

Installs the declared Xcode release with xcodes and selects it. --check reports
the selected version only. Unattended software updates do not run this.`;

const XcodePin = Schema.Struct({
  version: Schema.Literal(1),
  release: Schema.NonEmptyString,
  build: Schema.NonEmptyString,
});

type XcodePin = typeof XcodePin.Type;

export type XcodeRelease = {
  version: string;
  build: string;
  selected: boolean;
  installed: boolean;
  path?: string;
};

const catalogLine = /^(.*) \(([^)]+)\) \[(Apple Silicon|Intel|Universal)\](.*)$/;

function parseCatalogLine(line: string): XcodeRelease | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("xcodes")) return undefined;
  const [left, path] = trimmed.split("\t");
  const match = catalogLine.exec(left ?? "");
  if (!match?.[1] || !match[2]) return undefined;
  const flags = match[4] ?? "";
  return {
    version: match[1].trim(),
    build: match[2],
    selected: flags.includes("(Selected)"),
    installed: flags.includes("(Installed") || flags.includes("(Selected)") || Boolean(path),
    ...(path ? { path } : {}),
  };
}

export function parseCatalog(contents: string): XcodeRelease[] {
  return contents
    .split(/\r?\n/)
    .map(parseCatalogLine)
    .filter((entry): entry is XcodeRelease => entry !== undefined);
}

export function satisfiesPin(version: string, pin: string): boolean {
  return version === pin;
}

export function pickInstallTarget(
  releases: readonly XcodeRelease[],
  pin: string,
): XcodeRelease | undefined {
  return releases.find((release) => satisfiesPin(release.version, pin));
}

function describeRelease(release: XcodeRelease): string {
  return `${release.version} (${release.build})`;
}

const xcodeEnv = { NO_COLOR: "1" };

const readPin = Effect.fn("readXcodePin")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = process.env.DOTFILES_XCODE_FILE || defaultPinPath;
  const contents = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({
          exitCode: 1,
          message: `cannot read Xcode pin ${path}: ${error.message}`,
        }),
    ),
  );
  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (error) =>
      new CliFailure({
        exitCode: 1,
        message: `Xcode pin ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
  return yield* Schema.decodeUnknownEffect(XcodePin)(parsed).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({ exitCode: 1, message: `Xcode pin ${path} is invalid: ${error.message}` }),
    ),
  );
});

const runXcodes = Effect.fn("runXcodes")(function* (
  args: readonly string[],
  options: { output?: "capture" | "inherit"; stdin?: "inherit" } = {},
) {
  const runner = yield* CommandRunner;
  return yield* runner.run("xcodes", args, {
    env: xcodeEnv,
    output: options.output ?? "capture",
    stdin: options.stdin,
  });
});

const catalog = Effect.fn("xcodeCatalog")(function* (args: readonly string[]) {
  const result = yield* runXcodes(args);
  if (result.status !== 0)
    return yield* fail(
      `xcodes ${args[0]} exited ${result.status}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
      result.status,
    );
  return parseCatalog(result.stdout);
});

const selectedRelease = (releases: readonly XcodeRelease[]) =>
  releases.find((release) => release.selected);

const checkPin = Effect.fn("checkXcodePin")(function* (pin: XcodePin) {
  const installed = yield* catalog(["installed"]);
  const selected = selectedRelease(installed);
  if (!selected)
    return yield* fail(
      "no Xcode is selected; install the declared release with mise run xcode:install",
    );
  if (!satisfiesPin(selected.version, pin.release) || selected.build !== pin.build) {
    return yield* fail(
      `selected Xcode is ${describeRelease(selected)}; pin is ${pin.release} (${pin.build})`,
    );
  }
  yield* Console.log(`Xcode ${describeRelease(selected)} matches the pin`);
});

const privileged = Effect.fn("runPrivilegedXcodeCommand")(function* (
  command: string,
  args: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const home = process.env.HOME || "";
  const configPath = process.env.DEVBOX_CONFIG || join(home, ".config/dotfiles/devbox.env");
  const wrapper = join(repoRoot, "identity/sops-devbox-sudo.ts");
  const config = yield* fs.stat(configPath).pipe(Effect.option);
  const useWrapper =
    Option.isSome(config) && config.value.type === "File" && (yield* fs.exists(wrapper));
  let resolved = command;
  if (!command.includes("/")) {
    const located = yield* runner.run("which", [command]);
    if (located.status !== 0 || !located.stdout.trim()) return yield* fail(`missing ${command}`);
    resolved = located.stdout.trim();
  }
  const result: CommandResult = useWrapper
    ? yield* runner.run(process.execPath, [wrapper, "--", resolved, ...args], { output: "inherit" })
    : yield* runner.run("sudo", ["-n", resolved, ...args], { output: "inherit" });
  if (result.status !== 0) {
    return yield* fail(
      `privileged ${command} exited ${result.status}; run \`sudo ${[resolved, ...args].join(" ")}\` in a terminal, then rerun mise run xcode:install; on a headless host, configure sops-devbox-sudo (docs/devbox.md)`,
      result.status,
    );
  }
});

const selectRelease = Effect.fn("selectXcodeRelease")(function* (release: XcodeRelease) {
  yield* Console.log(`Selecting Xcode ${describeRelease(release)}`);
  yield* privileged("xcodes", ["select", "--no-color", release.version]);
  yield* privileged("xcodebuild", ["-license", "accept"]);
});

const installRelease = Effect.fn("installXcodeRelease")(function* (pin: XcodePin) {
  yield* requirePrefixOwner();
  const installed = yield* catalog(["installed"]);
  const selected = selectedRelease(installed);
  if (selected && satisfiesPin(selected.version, pin.release)) {
    yield* Console.log(`Xcode ${describeRelease(selected)} already selected`);
    return;
  }
  const present = installed.find((release) => satisfiesPin(release.version, pin.release));
  if (present) {
    yield* selectRelease(present);
    return;
  }
  const available = yield* catalog(["list"]);
  const target = pickInstallTarget(available, pin.release);
  if (!target) return yield* fail(`no stable Xcode ${pin.release} is available from xcodes`);
  yield* Console.log(`Installing Xcode ${describeRelease(target)}`);
  const install = yield* runXcodes(
    [
      "install",
      target.version,
      "--update",
      "--experimental-unxip",
      "--empty-trash",
      "--no-superuser",
      "--no-color",
    ],
    { output: "inherit", stdin: "inherit" },
  );
  if (install.status !== 0) {
    return yield* fail(
      `xcodes install exited ${install.status}; if Apple ID authentication failed, complete it in a terminal and retry`,
      install.status,
    );
  }
  yield* selectRelease(target);
});

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  let check = false;
  for (const argument of args) {
    if (argument === "--check") check = true;
    else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }
  const pin = yield* readPin();
  if (check) return yield* checkPin(pin);
  yield* installRelease(pin);
  yield* checkPin(pin);
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  runMain(program);
}
