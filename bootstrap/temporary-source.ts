import { Console, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { fail } from "../lib/program.ts";

const xmlEntities: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

const updaterUnits = (home: string) => [
  {
    path: join(home, ".config/systemd/user/dotfiles-software-update.service"),
    checkout: (content: string) => /"([^"]+)\/maintenance\/run\.ts"/.exec(content)?.[1],
  },
  {
    path: join(home, "Library/LaunchAgents/local.dotfiles.software-update.plist"),
    checkout: (content: string) =>
      /<string>([^<]+)\/maintenance\/run\.ts<\/string>/
        .exec(content)?.[1]
        ?.replaceAll(/&(?:amp|lt|gt|quot|apos);/g, (entity) => xmlEntities[entity] ?? entity),
  },
];

// A temporary source renders no updater, so it must not take over a home whose
// updater still runs from an existing persistent checkout.
export const checkTemporarySource = Effect.fn("checkTemporarySource")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const unit of updaterUnits(home)) {
    if (!(yield* fs.exists(unit.path))) continue;
    const checkout = unit.checkout(yield* fs.readFileString(unit.path));
    if (checkout !== undefined && (yield* fs.exists(checkout))) {
      return yield* fail(
        `${unit.path} runs updates from ${checkout}; apply from that checkout, not a temporary source`,
      );
    }
    yield* Console.warn(
      `${unit.path} points at a checkout that no longer exists; disable and remove it if it is still scheduled`,
    );
  }
});
