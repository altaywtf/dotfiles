#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-sops-sudo-test." });
    const home = join(temporary, "home");
    const config = join(temporary, "devbox.env");
    const payload = join(temporary, "sudo.sops.json");
    const sopsIdentity = join(temporary, "sops-keys.txt");
    const sudoIdentity = join(temporary, "sudo-keys.txt");
    const fakeSops = join(temporary, "sops");
    const log = join(temporary, "sops.log");
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(payload, "{}\n");
    yield* fs.writeFileString(sopsIdentity, "# sops fixture\n", { mode: 0o600 });
    yield* fs.writeFileString(sudoIdentity, "# sudo fixture\n", { mode: 0o600 });
    yield* fs.writeFileString(
      config,
      `SOPS_SUDO_SECRET_FILE=${payload}\nSUDO_AGE_IDENTITY_FILE=${sudoIdentity}\n`,
      { mode: 0o600 },
    );
    yield* fs.writeFileString(
      fakeSops,
      `#!/bin/sh
[ "$SUDO_AGE_IDENTITY_FILE" = "$EXPECTED_SUDO_IDENTITY" ] || exit 71
[ "$SOPS_AGE_KEY_FILE" = "$EXPECTED_SOPS_IDENTITY" ] || exit 72
case "\${4:-}" in *--consume-secret*/*bin/true*) ;; *) exit 73 ;; esac
printf '<%s>' "$@" >"$FAKE_SOPS_LOG"
`,
      { mode: 0o700 },
    );
    const result = yield* runner.run(
      process.execPath,
      [join(repoRoot, "identity/sops-devbox-sudo.ts"), "--", "/usr/bin/true"],
      {
        env: {
          HOME: home,
          DEVBOX_CONFIG: config,
          SOPS_BINARY: fakeSops,
          SOPS_AGE_KEY_FILE: sopsIdentity,
          EXPECTED_SUDO_IDENTITY: sudoIdentity,
          EXPECTED_SOPS_IDENTITY: sopsIdentity,
          FAKE_SOPS_LOG: log,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      yield* fs.readFileString(log),
      new RegExp(
        `<exec-env><--same-process><${payload.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}>`,
      ),
    );
    yield* Console.log("ok SOPS sudo runner preserves both age identity boundaries");
  }).pipe(
    Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);

runMain(program);
