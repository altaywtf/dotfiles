#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { CommandRunner, runChecked, runCommand } from "../../lib/command.ts";
import {
  launchdLabel,
  plistXml,
  resolveLaunchdNamespace,
  resolveLaunchdNamespaceContract,
} from "../../lib/darwin/launchd.ts";
import { CliFailure, fail, runMain } from "../../lib/program.ts";

const usage = `Usage:
  bootstrap/darwin/install-devbox-service-daemons.ts --user <name> [services]

Services:
  --colima           Run the user's colima-ensure script once at system boot.
  --software-updates Run per-user Topgrade every six hours and at boot.

Options:
  --check            Verify the selected LaunchDaemons without changing them.
  --print-labels     Print the generic labels for the selected user and exit.
  --namespace NAME   Stable label namespace; defaults to local.dotfiles.
  --updates-repository PATH
                      Target user's persistent dotfiles checkout; required for updates.

The installer must run as root on macOS. It creates root-owned system
LaunchDaemons that drop privileges to the selected user.`;

const InstallerOptions = Schema.Struct({
  user: Schema.NonEmptyString,
  namespace: Schema.String,
  colima: Schema.Boolean,
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
  readonly options: InstallerOptions;
  readonly target: Target;
  readonly namespace: string;
  readonly labels: { readonly colima: string };
  readonly launchDaemonDir: string;
};
const parseArguments = Effect.fn("parseServiceInstallerArguments")(function* (
  argv: readonly string[],
) {
  const values = {
    user: "",
    namespace: process.env.DOTFILES_LAUNCHD_NAMESPACE || "",
    colima: false,
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
  while (args.length > 0) {
    const flag = args.shift()!;
    switch (flag) {
      case "--user":
        values.user = take(flag);
        break;
      case "--namespace":
        values.namespace = take(flag);
        break;
      case "--colima":
        values.colima = true;
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

function labels(user: string, namespace: string) {
  return {
    colima: launchdLabel("colima", user, namespace),
  };
}

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

const checkJob = Effect.fn("checkLaunchdJob")(function* (context: ServiceContext, label: string) {
  const plist = join(context.launchDaemonDir, `${label}.plist`);
  const stat = yield* checked("/usr/bin/stat", ["-f", "%Su:%Sg:%Lp", plist]);
  if (stat.stdout.trim() !== "root:wheel:644")
    return yield* fail(`${label} plist must be root:wheel mode 0644`);
  const status = yield* run("/bin/launchctl", ["print", `system/${label}`]);
  if (status.status !== 0) return yield* fail(`${label} is not loaded`);
  yield* Console.log(`ok ${label} loaded for ${context.target.user}`);
});

const bootout = Effect.fn("bootoutLaunchdJob")(function* (label: string) {
  if ((yield* run("/bin/launchctl", ["print", `system/${label}`])).status !== 0) return;
  yield* checked("/bin/launchctl", ["bootout", `system/${label}`]);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    if ((yield* run("/bin/launchctl", ["print", `system/${label}`])).status !== 0) return;
    yield* Effect.sleep("100 millis");
  }
  return yield* fail(`system/${label} remains loaded after bootout`);
});

const installJob = Effect.fn("installLaunchdJob")(function* (
  context: ServiceContext,
  source: string,
  label: string,
) {
  yield* bootout(label);
  const target = join(context.launchDaemonDir, `${label}.plist`);
  yield* checked("/usr/bin/install", ["-o", "root", "-g", "wheel", "-m", "0644", source, target]);
  yield* checked("/bin/launchctl", ["bootstrap", "system", target]);
  yield* checked("/bin/launchctl", ["enable", `system/${label}`]);
  yield* checked("/bin/launchctl", ["kickstart", "-k", `system/${label}`]);
  yield* checked("/bin/launchctl", ["print", `system/${label}`]);
  yield* Console.log(`installed ${label} for ${context.target.user}`);
});

const persistNamespace = Effect.fn("persistLaunchdNamespace")(function* (context: ServiceContext) {
  const fs = yield* FileSystem.FileSystem;
  const directory = join(context.target.home, ".config/dotfiles");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  yield* fs.chown(directory, context.target.uid, -1);
  const destination = join(directory, "launchd-namespace");
  const temporary = join(directory, `.launchd-namespace.${process.pid}`);
  yield* fs.writeFileString(temporary, `${context.namespace}\n`, { mode: 0o600 });
  yield* fs.chown(temporary, context.target.uid, -1);
  yield* fs.rename(temporary, destination);
});

const writePlist = Effect.fn("writeServicePlist")(function* (path: string, xml: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, xml, { mode: 0o600 });
  yield* checked("/usr/bin/plutil", ["-lint", path]);
});

const prepareColima = Effect.fn("prepareColimaService")(function* (target: Target) {
  const binary = yield* findExecutable(target, "colima");
  if (!binary) return yield* fail("missing colima binary");
  const start = join(target.home, ".local/bin/colima-ensure");
  if (!(yield* executable(start))) return yield* fail(`missing executable ${start}`);
  return { binary, start };
});

const checkColima = Effect.fn("checkColimaService")(function* (
  context: ServiceContext,
  colima: { binary: string; start: string },
) {
  yield* checkJob(context, context.labels.colima);
  const uid = process.getuid?.() ?? -1;
  if (uid === 0 || uid === context.target.uid) {
    const status = yield* runAsTarget(context.target, colima.binary, ["status"]);
    if (!/colima is running/i.test(`${status.stdout}\n${status.stderr}`))
      return yield* fail(`${context.labels.colima} is loaded but Colima is not running`);
  } else
    yield* Console.log(
      `skipped ${context.labels.colima} functional check (requires root or ${context.target.user})`,
    );
});

const installColima = Effect.fn("installColimaService")(function* (
  context: ServiceContext,
  temporary: string,
  colima: { binary: string; start: string },
) {
  yield* runAsTarget(context.target, colima.start);
  const logDirectory = join(context.target.home, ".local/log/colima");
  yield* checked("/usr/bin/install", [
    "-d",
    "-o",
    context.target.user,
    "-g",
    context.target.group,
    "-m",
    "0750",
    logDirectory,
  ]);
  const plist = join(temporary, `${context.labels.colima}.plist`);
  yield* writePlist(
    plist,
    plistXml({
      label: context.labels.colima,
      user: context.target.user,
      group: context.target.group,
      workingDirectory: context.target.home,
      stdout: join(logDirectory, "launchd.log"),
      stderr: join(logDirectory, "launchd-error.log"),
      arguments: [colima.start],
      keepAlive: false,
    }),
  );
  yield* installJob(context, plist, context.labels.colima);
  yield* checkColima(context, colima);
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
    const output = labels(options.user, namespace);
    yield* Console.log(output.colima);
    return;
  }
  if (process.platform !== "darwin") return yield* fail("this installer supports macOS only");
  if (!options.colima && !options.softwareUpdates)
    return yield* fail("select at least one service");
  const target = yield* resolveTarget(options.user);
  namespace = yield* resolveLaunchdNamespaceContract(
    options.namespace,
    join(target.home, ".config/dotfiles/launchd-namespace"),
    target.uid,
  );
  const context: ServiceContext = {
    options,
    target,
    namespace,
    labels: labels(target.user, namespace),
    launchDaemonDir: "/Library/LaunchDaemons",
  };
  const colima = options.colima ? yield* prepareColima(target) : undefined;
  if (options.softwareUpdates) {
    // Keep update-only dependencies out of the standalone installer path.
    const { installUpdateJobs } = yield* Effect.promise(
      () => import("../../maintenance/darwin/devbox.ts"),
    );
    const node = yield* findExecutable(target, "node");
    if (!node) return yield* fail(`missing Node for ${target.user}`);
    const resolvedNode = (yield* runAsTarget(target, node, [
      "-p",
      "process.execPath",
    ])).stdout.trim();
    yield* installUpdateJobs({
      target,
      node: resolvedNode,
      repository: options.updatesRepository,
      namespace,
      check: options.check,
    });
  }
  if (options.check) {
    if (colima) yield* checkColima(context, colima);
    return;
  }
  if ((process.getuid?.() ?? -1) !== 0) return yield* fail("run this installer as root");
  yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: process.env.TMPDIR || "/tmp",
        prefix: "dotfiles-service-daemons.",
      });
      yield* persistNamespace(context);
      if (colima) yield* installColima(context, temporary, colima);
    }),
  );
  yield* Console.log("devbox service daemon installation ok");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
