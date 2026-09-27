import { Console, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { fail } from "../lib/program.ts";

const updaterUnits = (home: string) => [
  {
    path: join(home, ".config/systemd/user/dotfiles-software-update.service"),
    companions: [join(home, ".config/systemd/user/dotfiles-software-update.timer")],
  },
  { path: join(home, "Library/LaunchAgents/local.dotfiles.software-update.plist"), companions: [] },
];

// A temporary source renders no updater. A unit from a persistent checkout that
// still exists means this home is maintained from there; one whose checkout is
// gone is a leftover of an earlier temporary apply.
export const reconcileTemporarySource = Effect.fn("reconcileTemporarySource")(function* (
  home: string,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const unit of updaterUnits(home)) {
    if (!(yield* fs.exists(unit.path))) continue;
    const checkout = /([^"<>\s]+)\/maintenance\/run\.ts/.exec(
      yield* fs.readFileString(unit.path),
    )?.[1];
    if (checkout !== undefined && (yield* fs.exists(checkout))) {
      return yield* fail(
        `${unit.path} runs updates from ${checkout}; apply from that checkout, not a temporary source`,
      );
    }
    for (const path of [unit.path, ...unit.companions]) {
      if (dryRun) yield* Console.log(`would remove stale updater unit ${path}`);
      else {
        yield* fs.remove(path, { force: true });
        yield* Console.log(`removed stale updater unit ${path}`);
      }
    }
  }
});
