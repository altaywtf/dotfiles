import { Console, Effect, FileSystem, Option } from "effect";
import { isAbsolute, join } from "node:path";
import { runChecked, runCommand } from "../../lib/command.ts";
import { launchdLabel, plistXml } from "../../lib/darwin/launchd.ts";
import { fail } from "../../lib/program.ts";
import { profileModelFile, readPersistedProfile } from "../../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../../profiles/model.ts";

type Target = { user: string; uid: number; group: string; home: string };
type UpdateOptions = {
  target: Target;
  node: string;
  repository: string;
  namespace: string;
  check: boolean;
};

// The administrator enrolls another user, whose environment is not visible
// here, so the job assumes mise's default data directory in that home.
function miseData(home: string): string {
  return join(home, ".local/share/mise");
}

export function updateJobs(options: UpdateOptions, prefix: string) {
  const { target, repository, namespace, node } = options;
  const logDirectory = join(target.home, "Library/Logs/dotfiles");
  const environment = {
    HOME: target.home,
    USER: target.user,
    LOGNAME: target.user,
    SHELL: "/bin/zsh",
    PATH: `${target.home}/.local/share/mise/shims:${target.home}/.local/bin:${prefix}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    HOMEBREW_NO_UPGRADE_QUIT_CASKS: "1",
    HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
  const definitions = [
    {
      service: "software-update",
      minute: 0,
      args: [
        join(miseData(target.home), "shims/topgrade"),
        "--config",
        join(target.home, ".config/topgrade.toml"),
        "--only",
        "brew_formula",
        "brew_cask",
        "github_cli_extensions",
        "custom_commands",
        "--no-tmux",
        "--no-ask-retry",
        "--no-self-update",
        "--notify-end",
        "never",
        "--yes",
      ],
    },
  ];
  return definitions.map(({ service, minute, args }) => {
    const label = launchdLabel(service, target.user, namespace);
    const log = join(logDirectory, `${service}.log`);
    return {
      label,
      log,
      xml: plistXml({
        label,
        user: target.user,
        group: target.group,
        workingDirectory: repository,
        stdout: log,
        stderr: log,
        arguments: [node, join(repository, "maintenance/run.ts"), service, "--", ...args],
        keepAlive: false,
        processType: "Background",
        environment,
        calendar: [0, 6, 12, 18].map((hour) => ({ hour, minute })),
      }),
    };
  });
}

const ownerFile = Effect.fn("checkUpdateOwnerFile")(function* (path: string, uid: number) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  const info = yield* fs.stat(path);
  if (
    Option.isSome(link) ||
    info.type !== "File" ||
    Option.getOrUndefined(info.uid) !== uid ||
    (info.mode & 0o022) !== 0
  ) {
    return yield* fail(
      `update file must be owned by uid ${uid} and not writable by others: ${path}`,
    );
  }
});

export const installUpdateJobs = Effect.fn("installUpdateJobs")(function* (options: UpdateOptions) {
  const { target, repository, node } = options;
  if (!options.check && process.getuid?.() !== 0) return yield* fail("install update jobs as root");
  if (target.uid <= 0 || !isAbsolute(repository) || !isAbsolute(node))
    return yield* fail("updates require a non-root user and absolute repository and Node paths");
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.realPath(target.home);
  const repo = yield* fs.realPath(repository);
  if (!repo.startsWith(`${home}/`))
    return yield* fail("the update checkout must belong to the target user's home");
  const repoInfo = yield* fs.stat(repo);
  if (Option.getOrUndefined(repoInfo.uid) !== target.uid || (repoInfo.mode & 0o022) !== 0)
    return yield* fail(
      "the update checkout must be owned by the target user and not writable by others",
    );
  const profile = yield* readPersistedProfile(join(home, ".config/dotfiles/profile"), target.uid);
  const model = yield* readProfileModelEffect(profileModelFile());
  const { capabilities } = requireProfile(model, profile);
  if (!capabilities.devbox) return yield* fail("system updates require a devbox profile");
  {
    const label = launchdLabel("homebrew-update", target.user, options.namespace);
    const oldPlist = `/Library/LaunchDaemons/${label}.plist`;
    const loaded = yield* runCommand("/bin/launchctl", ["print", `system/${label}`]);
    if ((yield* fs.exists(oldPlist)) || loaded.status === 0)
      return yield* fail(
        `wait for ${label} to finish, then disable, bootout, and remove its plist before enrolling single-owner updates`,
      );
  }
  yield* ownerFile(join(home, ".config/topgrade.toml"), target.uid);
  yield* runChecked("/usr/bin/sudo", ["-u", target.user, "-H", node, "--version"], { cwd: home });
  const brew = process.arch === "arm64" ? "/opt/homebrew/bin/brew" : "/usr/local/bin/brew";
  const prefix = (yield* runChecked(brew, ["--prefix"])).stdout.trim();
  if (Option.getOrUndefined((yield* fs.stat(prefix)).uid) !== target.uid) {
    return yield* fail("only the Homebrew prefix owner can enroll Homebrew updates");
  }
  yield* runChecked(
    "/usr/bin/sudo",
    ["-u", target.user, "-H", join(miseData(target.home), "shims/topgrade"), "--version"],
    { cwd: home },
  );
  const guiService = `gui/${target.uid}/local.dotfiles.software-update`;
  const gui = yield* runCommand("/bin/launchctl", ["print", guiService]);
  if (gui.status === 0)
    return yield* fail(`disable the GUI updater before enrolling system updates: ${guiService}`);

  const jobs = updateJobs(options, prefix);
  // Preflight every job before changing any plist or launchd state.
  const states = yield* Effect.forEach(
    jobs,
    Effect.fn("inspectUpdateJob")(function* (job) {
      const path = `/Library/LaunchDaemons/${job.label}.plist`;
      const exists = yield* fs.exists(path);
      const link = yield* fs.readLink(path).pipe(Effect.option);
      if (Option.isSome(link))
        return yield* fail(`system update plist must not be a symlink: ${path}`);
      let matches = false;
      if (exists) {
        yield* ownerFile(path, 0);
        const info = yield* fs.stat(path);
        if ((info.mode & 0o777) !== 0o644 || Option.getOrUndefined(info.gid) !== 0)
          return yield* fail(`expected root:wheel mode 0644: ${path}`);
        matches = (yield* fs.readFileString(path)) === job.xml;
      }
      const current = yield* runCommand("/bin/launchctl", ["print", `system/${job.label}`]);
      if (options.check && (!matches || current.status !== 0))
        return yield* fail(
          `${job.label} is missing, unloaded, or differs from the selected update contract`,
        );
      if (current.status === 0 && !matches)
        return yield* fail(
          `wait for ${job.label} to finish, then disable and bootout before changing its plist`,
        );
      return { ...job, path, loaded: current.status === 0 };
    }),
  );
  if (options.check) {
    for (const job of jobs) yield* Console.log(`ok ${job.label}; log: ${job.log}`);
    return;
  }

  const logs = join(home, "Library/Logs/dotfiles");
  yield* runChecked("/usr/bin/sudo", [
    "-u",
    target.user,
    "-H",
    "/usr/bin/install",
    "-d",
    "-m",
    "0700",
    logs,
  ]);
  for (const job of jobs) {
    if (yield* fs.exists(job.log)) yield* ownerFile(job.log, target.uid);
    if (Option.isSome(yield* fs.readLink(job.log).pipe(Effect.option)))
      return yield* fail(`update log must not be a symlink: ${job.log}`);
    yield* runChecked("/usr/bin/sudo", ["-u", target.user, "-H", "/usr/bin/touch", job.log]);
    yield* runChecked("/usr/bin/sudo", ["-u", target.user, "-H", "/bin/chmod", "0600", job.log]);
  }
  // User and GUI domains share disabled overrides; the user domain also exists without a GUI login.
  yield* runChecked("/bin/launchctl", [
    "disable",
    `user/${target.uid}/local.dotfiles.software-update`,
  ]);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-update-jobs." });
      for (const job of states) {
        if (!job.loaded) {
          const source = join(temporary, `${job.label}.plist`);
          yield* fs.writeFileString(source, job.xml, { mode: 0o600 });
          yield* runChecked("/usr/bin/plutil", ["-lint", source]);
          yield* runChecked("/usr/bin/install", [
            "-o",
            "root",
            "-g",
            "wheel",
            "-m",
            "0644",
            source,
            job.path,
          ]);
        }
        yield* runChecked("/bin/launchctl", ["enable", `system/${job.label}`]);
        if (!job.loaded) yield* runChecked("/bin/launchctl", ["bootstrap", "system", job.path]);
        yield* Console.log(`${job.loaded ? "retained" : "enrolled"} ${job.label}; log: ${job.log}`);
      }
    }),
  );
});
