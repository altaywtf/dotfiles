#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { CommandRunner, runChecked, runCommand } from "../../lib/command.ts";
import {
  launchdLabel,
  resolveLaunchdNamespace,
  resolveLaunchdNamespaceContract,
} from "../../lib/darwin/launchd.ts";
import { CliFailure, fail, runMain } from "../../lib/program.ts";
import { installUpdateJobs } from "../../maintenance/darwin/devbox.ts";

const usage = `Usage:
  bootstrap/darwin/install-devbox-service-daemons.ts --user <name> [services]

Services:
  --software-updates Run per-user Topgrade every six hours and at boot.

Options:
  --check            Verify the selected LaunchDaemons without changing them.
  --print-labels     Print the update job label for the selected user and exit.
  --namespace NAME   Stable label namespace; defaults to local.dotfiles.
  --updates-repository PATH
                      Target user's persistent dotfiles checkout; required for updates.

The installer must run as root on macOS. It creates root-owned system
LaunchDaemons that drop privileges to the selected user.`;

const InstallerOptions = Schema.Struct({
  user: Schema.NonEmptyString,
  namespace: Schema.String,
  check: Schema.Boolean,
  printLabels: Schema.Boolean,
  softwareUpdates: Schema.Boolean,
  updatesRepository: Schema.String,
});
type InstallerOptions = typeof InstallerOptions.Type;

type Target = {
  readonly user: string;
  readonly uid: number;
  readonly group: string;
  readonly home: string;
};
type ServiceContext = {
  readonly target: Target;
  readonly namespace: string;
};
const parseArguments = Effect.fn("parseServiceInstallerArguments")(function* (
  argv: readonly string[],
) {
  const values = {
    user: "",
    namespace: process.env.DOTFILES_LAUNCHD_NAMESPACE || "",
    check: false,
    printLabels: false,
    softwareUpdates: false,
    updatesRepository: "",
  };
  const args = [...argv];
  const take = (flag: string): string => {
    const value = args.shift();
    if (!value) throw new CliFailure({ exitCode: 1, message: `${flag} requires a value` });
    return value;
  };
  for (let flag = args.shift(); flag !== undefined; flag = args.shift()) {
    switch (flag) {
      case "--user":
        values.user = take(flag);
        break;
      case "--namespace":
        values.namespace = take(flag);
        break;
      case "--software-updates":
        values.softwareUpdates = true;
        break;
      case "--updates-repository":
        values.updatesRepository = take(flag);
        break;
      case "--check":
        values.check = true;
        break;
      case "--print-labels":
        values.printLabels = true;
        break;
      case "-h":
      case "--help":
        yield* Console.log(usage);
        return undefined;
      default:
        yield* Console.error(usage);
        return yield* fail(`unknown argument: ${flag}`, 2);
    }
  }
  const options = yield* Schema.decodeUnknownEffect(InstallerOptions)(values).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })),
  );
  if (!/^[A-Za-z0-9._-]+$/.test(options.user))
    return yield* fail(`unsupported user name: ${options.user}`);
  if (options.softwareUpdates !== Boolean(options.updatesRepository))
    return yield* fail("--software-updates requires --updates-repository PATH");
  return options;
});

const run = (command: string, args: readonly string[] = [], inherit = false) =>
  runCommand(command, args, { output: inherit ? "inherit" : "capture" });

const checked = Effect.fn("runCheckedServiceCommand")(function* (
  command: string,
  args: readonly string[] = [],
  inherit = false,
) {
  const result = yield* run(command, args, inherit);
  if (result.status !== 0)
    return yield* fail(`${command} ${args.join(" ")} exited ${result.status}`);
  return result;
});

const resolveTarget = Effect.fn("resolveServiceTarget")(function* (user: string) {
  const uidResult = yield* run("/usr/bin/id", ["-u", user]);
  if (uidResult.status !== 0 || !/^\d+$/.test(uidResult.stdout.trim()))
    return yield* fail(`unknown user: ${user}`);
  const group = yield* checked("/usr/bin/id", ["-gn", user]);
  const homeResult = yield* checked("/usr/bin/dscl", [
    ".",
    "-read",
    `/Users/${user}`,
    "NFSHomeDirectory",
  ]);
  const home = homeResult.stdout.trim().split(/\s+/).at(-1) || "";
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(home).pipe(Effect.option);
  if (!home || Option.isNone(info) || info.value.type !== "Directory")
    return yield* fail(`missing home for ${user}`);
  return {
    user,
    uid: Number(uidResult.stdout.trim()),
    group: group.stdout.trim(),
    home,
  } satisfies Target;
});

const executable = Effect.fn("serviceExecutable")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0;
});

const findExecutable = Effect.fn("findServiceExecutable")(function* (target: Target, name: string) {
  for (const path of [
    join(target.home, ".local/bin", name),
    join(target.home, ".local/share/mise/shims", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ]) {
    if (yield* executable(path)) return path;
  }
  return undefined;
});

const runAsTarget = Effect.fn("runServiceCommandAsTarget")(function* (
  target: Target,
  command: string,
  args: readonly string[] = [],
) {
  const uid = process.getuid?.() ?? -1;
  if (uid === target.uid) return yield* checked(command, args);
  if (uid === 0)
    return yield* runChecked("/usr/bin/sudo", ["-u", target.user, "-H", command, ...args], {
      cwd: target.home,
    });
  return yield* fail(`run this step as root or ${target.user}`);
});

// The target owns this directory, so write it as the target: root must not follow its symlinks.
const persistNamespace = Effect.fn("persistLaunchdNamespace")(function* (context: ServiceContext) {
  yield* runAsTarget(context.target, "/bin/sh", [
    "-c",
    String.raw`set -eu; umask 077; mkdir -p "$1"; chmod 0700 "$1"; tmp=$(mktemp "$1/.launchd-namespace.XXXXXX"); printf "%s\n" "$2" > "$tmp"; mv -f "$tmp" "$1/launchd-namespace"`,
    "persist-launchd-namespace",
    join(context.target.home, ".config/dotfiles"),
    context.namespace,
  ]);
});

const program = Effect.gen(function* () {
  const options = yield* parseArguments(process.argv.slice(2));
  if (!options) return;
  let namespace = yield* Effect.try({
    try: () => resolveLaunchdNamespace(options.namespace),
    catch: (error) => error,
  });
  if (options.printLabels) {
    if (process.platform === "darwin") {
      const target = yield* resolveTarget(options.user).pipe(Effect.option);
      if (Option.isSome(target))
        namespace = yield* resolveLaunchdNamespaceContract(
          options.namespace,
          join(target.value.home, ".config/dotfiles/launchd-namespace"),
          target.value.uid,
        );
    }
    yield* Console.log(launchdLabel("software-update", options.user, namespace));
    return;
  }
  if (process.platform !== "darwin") return yield* fail("this installer supports macOS only");
  if (!options.softwareUpdates) return yield* fail("select at least one service");
  const target = yield* resolveTarget(options.user);
  namespace = yield* resolveLaunchdNamespaceContract(
    options.namespace,
    join(target.home, ".config/dotfiles/launchd-namespace"),
    target.uid,
  );
  const node = yield* findExecutable(target, "node");
  if (!node) return yield* fail(`missing Node for ${target.user}`);
  const resolvedNode = (yield* runAsTarget(target, node, ["-p", "process.execPath"])).stdout.trim();
  yield* installUpdateJobs({
    target,
    node: resolvedNode,
    repository: options.updatesRepository,
    namespace,
    check: options.check,
  });
  if (options.check) return;
  if ((process.getuid?.() ?? -1) !== 0) return yield* fail("run this installer as root");
  yield* persistNamespace({ target, namespace });
  yield* Console.log("devbox service daemon installation ok");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
