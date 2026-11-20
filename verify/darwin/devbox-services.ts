#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, runCommand } from "../../lib/command.ts";
import { launchdLabel, resolveLaunchdNamespaceContract } from "../../lib/darwin/launchd.ts";
import { CliFailure, fail, runMain } from "../../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const home = process.env.HOME || "";
const configPath = process.env.DEVBOX_CONFIG || join(home, ".config/dotfiles/devbox.env");
const Config = Schema.Struct({ DEVBOX_USER: Schema.optional(Schema.NonEmptyString) });

const run = runCommand;

const readConfig = Effect.fn("readDevboxVerificationConfig")(function* () {
  yield* Console.log("\n## local devbox config");
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(configPath).pipe(Effect.option);
  if (Option.isNone(info)) {
    yield* Console.log(`ok optional ${configPath} is absent; using defaults`);
    return {};
  }
  if (info.value.type !== "File" || (info.value.mode & 0o777) !== 0o600) {
    return yield* fail(`${configPath} must have mode 0600`);
  }
  const values: Record<string, string> = {};
  for (const line of (yield* fs.readFileString(configPath)).split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) {
      continue;
    }
    const raw = match[2];
    values[match[1]] =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
  const config = yield* Schema.decodeUnknownEffect(Config)(values).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({ exitCode: 1, message: `invalid ${configPath}: ${error.message}` }),
    ),
  );
  yield* Console.log(`ok ${configPath} mode 600`);
  return config;
});

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    yield* Console.log("Usage:\n  verify/darwin/devbox-services.ts");
    return;
  }
  if (args.length > 0) {
    return yield* fail(`unknown argument: ${args[0]}`, 2);
  }
  const config = yield* readConfig();
  const user = config.DEVBOX_USER || process.env.DEVBOX_USER || process.env.USER || "";
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    return yield* fail(`unsupported DEVBOX_USER: ${user}`);
  }

  yield* Console.log("\n## SOPS age identity");
  const sops = yield* run(process.execPath, [
    join(repoRoot, "identity/configure-sops-age-identity.ts"),
    "--check",
  ]);
  if (sops.status !== 0) {
    return yield* fail(`SOPS age identity check exited ${sops.status}`);
  }
  yield* Console.log("ok owner, permissions, recipient, and SOPS round trip");

  yield* Console.log("\n## managed launchd daemons");
  const namespace = yield* resolveLaunchdNamespaceContract(
    process.env.DOTFILES_LAUNCHD_NAMESPACE || "",
    join(home, ".config/dotfiles/launchd-namespace"),
    process.getuid?.(),
  );
  const fs = yield* FileSystem.FileSystem;
  let found = false;
  for (const service of ["software-update"]) {
    const label = launchdLabel(service, user, namespace);
    const plist = `/Library/LaunchDaemons/${label}.plist`;
    if (!(yield* fs.exists(plist))) {
      continue;
    }
    found = true;
    const stat = yield* run("/usr/bin/stat", ["-f", "%Su:%Sg:%Lp", plist]);
    if (stat.status !== 0 || stat.stdout.trim() !== "root:wheel:644") {
      return yield* fail(`${label} plist must be root:wheel mode 0644`);
    }
    if ((yield* run("/bin/launchctl", ["print", `system/${label}`])).status !== 0) {
      return yield* fail(`${label} is not loaded`);
    }
    yield* Console.log(`ok ${label} loaded`);
  }
  if (!found) {
    yield* Console.log("ok no managed developer system daemons on this machine");
  }
  yield* Console.log("\ndevbox verification ok");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
