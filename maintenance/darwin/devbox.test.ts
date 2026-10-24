import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option } from "effect";
import { CommandRunner } from "../../lib/command.ts";
import { installUpdateJobs, updateJobs } from "./devbox.ts";

test("system updates keep packages and tools in one headless owner job", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-system-updates-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const target = { user: "example", uid: 502, group: "staff", home: "/Users/example & space" };
  const repository = join(target.home, "projects/dotfiles");
  const jobs = updateJobs(
    { target, repository, node: "/fixture/node", namespace: "local.dotfiles", check: false },
    "/opt/homebrew",
  );
  const [job, ...others] = jobs;
  assert.ok(job);
  assert.deepEqual(others, []);
  const path = join(root, "job.plist");
  await writeFile(path, job.xml);
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const plist = JSON.parse(result.stdout);
  assert.partialDeepStrictEqual(plist, {
    UserName: "example",
    GroupName: "staff",
    WorkingDirectory: repository,
    EnvironmentVariables: {
      HOME: target.home,
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_NO_INSTALL_CLEANUP: "1",
      HOMEBREW_NO_UPGRADE_QUIT_CASKS: "1",
      HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS: "1",
    },
    RunAtLoad: true,
    KeepAlive: false,
    SessionCreate: true,
    Umask: 0o077,
    StartCalendarInterval: [0, 6, 12, 18].map((Hour) => ({ Hour, Minute: 0 })),
  });
  assert.equal(plist.StandardOutPath, plist.StandardErrorPath);
  assert.deepEqual(plist.ProgramArguments, [
    "/fixture/node",
    join(repository, "maintenance/run.ts"),
    "software-update",
    "--",
    join(target.home, ".local/share/mise/shims/topgrade"),
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
  ]);
});

// Both devbox profiles must enroll; the refusals do not depend on the profile.
const enrollments = [
  ["devbox", "headless"],
  ["personal-devbox", "headless"],
  ["devbox", "consumer"],
  ["devbox", "loaded"],
  ["devbox", "plist"],
] as const;
for (const [profile, scenario] of enrollments) {
  test(`${profile} enrollment handles ${scenario} without a shared repair script`, async (t) => {
    const uid = process.getuid?.();
    assert.ok(uid);
    const home = await mkdtemp(join(tmpdir(), "dotfiles-solo-update-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    const repository = join(home, "repo");
    await mkdir(repository);
    await mkdir(join(home, ".config/dotfiles"), { recursive: true });
    await writeFile(join(home, ".config/dotfiles/profile"), `${profile}\n`, {
      mode: 0o600,
    });
    await writeFile(join(home, ".config/topgrade.toml"), "", { mode: 0o600 });
    const calls: string[][] = [];
    const oldLabel = "local.dotfiles.homebrew-update.fixture";
    const oldPlist = `/Library/LaunchDaemons/${oldLabel}.plist`;
    const runner = CommandRunner.of({
      run: (command, args = []) => {
        calls.push([command, ...args]);
        const loaded = scenario === "loaded" && args[1] === `system/${oldLabel}`;
        return Effect.succeed({
          status: args[0] === "print" && !loaded ? 113 : 0,
          stdout: [command, ...args].some((part) => part.endsWith("/brew"))
            ? "/fixture/prefix\n"
            : "",
          stderr: "",
        });
      },
    });
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0);
    t.onTestFinished(() => getuid.mockRestore());
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const info = yield* fs.stat(home);
        return yield* installUpdateJobs({
          target: { user: "fixture", uid, group: "staff", home },
          repository,
          node: "/fixture/node",
          namespace: "local.dotfiles",
          check: false,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: (path) =>
              path === oldPlist ? Effect.succeed(scenario === "plist") : fs.exists(path),
            stat: (path) =>
              path === "/fixture/prefix"
                ? Effect.succeed({
                    ...info,
                    uid: Option.some(scenario === "consumer" ? uid + 1 : uid),
                  })
                : fs.stat(path),
          }),
          Effect.result,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(CommandRunner, runner)),
    );
    // The prefix owner can edit brew, so root must never execute it directly.
    assert.equal(
      calls.some((call) => call[0]?.endsWith("/brew")),
      false,
    );
    if (scenario === "headless") {
      assert.equal(outcome._tag, "Success");
      assert.deepEqual(
        calls.filter((call) => call[1] === "bootstrap"),
        [
          [
            "/bin/launchctl",
            "bootstrap",
            "system",
            "/Library/LaunchDaemons/local.dotfiles.software-update.fixture.plist",
          ],
        ],
      );
    } else {
      assert.equal(outcome._tag, "Failure");
      assert.match(
        String(outcome),
        scenario === "consumer" ? /only the Homebrew prefix owner/ : /remove its plist/,
      );
      assert.equal(
        calls.some((call) => ["bootstrap", "disable", "bootout"].includes(call[1] || "")),
        false,
      );
    }
  });
}
