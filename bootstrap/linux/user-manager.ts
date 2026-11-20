import { Effect } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../../lib/command.ts";
import { CliFailure, fail } from "../../lib/program.ts";

export const convergeUserManager = Effect.fn("convergeUserManager")(function* (
  home: string,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "linux" || dryRun) {
    return;
  }
  const runner = yield* CommandRunner;
  const environment = yield* runner
    .run("systemctl", ["--user", "show-environment"], { output: "capture" })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (!environment || environment.status !== 0) {
    return;
  }
  const current =
    environment.stdout
      .split("\n")
      .find((line) => line.startsWith("PATH="))
      ?.slice(5) ?? "/usr/local/bin:/usr/bin:/bin";
  const front = [".local/share/mise/shims", ".local/libexec/dotfiles/bin", ".local/bin"].map(
    (part) => join(home, part),
  );
  const merged = [
    ...front,
    ...current.split(":").filter((part) => part && !front.includes(part)),
  ].join(":");
  for (const args of [["daemon-reload"], ["set-environment", `PATH=${merged}`]]) {
    const operation = `systemctl --user ${args[0]}`;
    const result = yield* runner
      .run("systemctl", ["--user", ...args], { output: "capture" })
      .pipe(
        Effect.mapError(
          (error) =>
            new CliFailure({ exitCode: 1, message: `${operation} failed: ${error.message}` }),
        ),
      );
    if (result.status !== 0) {
      return yield* fail(
        `${operation} exited ${result.status}: ${result.stderr.trim()}`,
        result.status,
      );
    }
  }
});
