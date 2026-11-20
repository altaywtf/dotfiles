import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const verifyDir = import.meta.dirname;
const hook = resolve(verifyDir, "pre-push.ts");
export const installer = resolve(verifyDir, "install-pre-push-hook.ts");

export type Repository = {
  path: string;
  oidLength: number;
  zeroOid: string;
};

export function run(path: string, args: Array<string>, allowFailure = false): string {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: path,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function init(root: string, format: "sha1" | "sha256" = "sha1"): Repository {
  const path = join(root, `repo-${format}`);
  run(root, ["git", "init", "--quiet", `--object-format=${format}`, path]);
  const oidLength = format === "sha256" ? 64 : 40;
  return { path, oidLength, zeroOid: "0".repeat(oidLength) };
}

export function commit(repo: Repository, content: string, name = "file.txt"): string {
  writeFileSync(join(repo.path, name), content);
  run(repo.path, ["git", "add", name]);
  run(repo.path, ["git", "commit", "--quiet", "-m", `update ${name}`]);
  return run(repo.path, ["git", "rev-parse", "HEAD"]);
}

export function invoke(
  repo: Repository,
  input: string,
  remote = "origin",
  location = "fixture",
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [hook, remote, location], {
    cwd: repo.path,
    encoding: "utf8",
    input,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}
