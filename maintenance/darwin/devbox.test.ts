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
  {
    const target = { user: "example", uid: 502, group: "staff", home: "/Users/example & space" };
    const repository = join(target.home, "projects/dotfiles");
    const jobs = updateJobs(
      {
        target,
        repository,
        node: "/fixture/node",
        namespace: "local.dotfiles",
        check: false,
      },
      "/opt/homebrew",
    );
    assert.equal(jobs.length, 1);
    for (const job of jobs) {
      const path = join(root, `${job.label}.plist`);
      await writeFile(path, job.xml);
      const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const plist = JSON.parse(result.stdout);
      assert.equal(plist.UserName, "example");
      assert.equal(plist.GroupName, "staff");
      assert.equal(plist.WorkingDirectory, repository);
      assert.equal(plist.EnvironmentVariables.HOME, target.home);
      assert.equal(plist.EnvironmentVariables.HOMEBREW_NO_AUTO_UPDATE, "1");
      assert.equal(plist.EnvironmentVariables.HOMEBREW_NO_INSTALL_CLEANUP, "1");
      assert.equal(plist.EnvironmentVariables.HOMEBREW_NO_UPGRADE_QUIT_CASKS, "1");
      assert.equal(plist.EnvironmentVariables.HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS, "1");
      assert.equal(plist.RunAtLoad, true);
      assert.equal(plist.KeepAlive, false);
      assert.equal(plist.SessionCreate, true);
      assert.equal(plist.Umask, 0o077);
      assert.equal(plist.StandardOutPath, plist.StandardErrorPath);
      assert.deepEqual(
        plist.StartCalendarInterval,
        [0, 6, 12, 18].map((Hour) => ({ Hour, Minute: 0 })),
      );
      assert.deepEqual(plist.ProgramArguments.slice(0, 4), [
        "/fixture/node",
        join(repository, "maintenance/run.ts"),
        "software-update",
        "--",
      ]);
      assert.deepEqual(plist.ProgramArguments.slice(4), [
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
    }
  }
});

for (const profile of ["devbox", "personal-devbox"]) {
  for (const scenario of ["headless", "consumer", "loaded", "plist"] as const) {
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
            stdout: command.endsWith("/brew") ? "/fixture/prefix\n" : "",
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
}
