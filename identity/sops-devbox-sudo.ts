#!/usr/bin/env node

import { ageIdentityPath } from "./age.ts";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, runCommand } from "../lib/command.ts";
import type { CommandResult } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const askpass = join(repoRoot, "identity/sudo-age-askpass.sh");
const home = process.env.HOME || "";
const configPath = process.env.DEVBOX_CONFIG || join(home, ".config/dotfiles/devbox.env");

const defaultSudoIdentity =
  process.env.SUDO_AGE_IDENTITY_FILE || join(home, ".config/dotfiles/sudo-age-identity.txt");

const usage = `Usage:
  identity/sops-devbox-sudo.ts -- <command> [args...]
  identity/sops-devbox-sudo.ts --nested -- <command> [args...]

Decrypts SUDO_PASSWORD_AGE from the configured SOPS payload, then exposes the
plaintext password only through a fixed sudo askpass process.`;

const DevboxSudoConfig = Schema.Struct({
  SOPS_SUDO_SECRET_FILE: Schema.NonEmptyString,
  SUDO_AGE_IDENTITY_FILE: Schema.optional(Schema.NonEmptyString),
});

function expandConfigValue(raw: string): string {
  const unquoted =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;

  return unquoted.replaceAll("${HOME}", home).replaceAll("$HOME", home);
}

const parseConfig = Effect.fn("parseSopsSudoConfig")(function* (contents: string) {
  const values: Record<string, string> = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);

    if (match?.[1] && match[2] !== undefined) {
      values[match[1]] = expandConfigValue(match[2]);
    }
  }

  return yield* Schema.decodeUnknownEffect(DevboxSudoConfig)(values).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({
          exitCode: 1,
          message: `SOPS_SUDO_SECRET_FILE is required in ${configPath}: ${error.message}`,
        }),
    ),
  );
});

const runRaw = Effect.fn("runSopsSudoCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly extendEnv?: boolean;
    readonly output?: "capture" | "inherit" | "ignore";
    readonly stdin?: "ignore" | "inherit";
  } = {},
): Effect.fn.Return<CommandResult, CliFailure, CommandRunner> {
  return yield* runCommand(command, args, {
    ...options,
    output: options.output ?? "inherit",
    stdin: options.stdin ?? "inherit",
  });
});

const executable = Effect.fn("sopsSudoExecutable")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);

  return Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0;
});

const findFixedExecutable = Effect.fn("findFixedSopsSudoExecutable")(function* (
  paths: ReadonlyArray<string>,
) {
  for (const path of paths) {
    if (yield* executable(path)) {
      return path;
    }
  }

  return undefined;
});

function sanitizedEnvironment(extra: Readonly<Record<string, string>>) {
  const environment: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "SUDO_PASSWORD_AGE" && value !== undefined) {
      environment[key] = value;
    }
  }

  return { ...environment, ...extra };
}

const validateOwnerFileMode = Effect.fn("validateSopsSudoFileMode")(function* (
  path: string,
  missing: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);

  if (Option.isNone(info) || info.value.type !== "File") {
    return yield* fail(missing);
  }

  if ((info.value.mode & 0o777) !== 0o600) {
    return yield* fail(`${path} mode is ${(info.value.mode & 0o777).toString(8)}, expected 600`);
  }
});

const consumeSecret = Effect.fn("consumeSopsSudoSecret")(function* (raw: ReadonlyArray<string>) {
  const args = [...raw];
  const nested = args[0] === "--nested";

  if (nested) {
    args.shift();
  }

  if (args[0] === "--") {
    args.shift();
  }

  if (args.length === 0) {
    return yield* fail("missing sudo command");
  }

  const ciphertext = process.env.SUDO_PASSWORD_AGE;

  if (!ciphertext) {
    return yield* fail("SOPS returned an empty sudo credential");
  }

  if (!(yield* executable("/usr/bin/sudo"))) {
    return yield* fail("missing /usr/bin/sudo");
  }

  if (!(yield* executable(askpass))) {
    return yield* fail("missing sudo askpass helper");
  }

  const identityFile = process.env.SUDO_AGE_IDENTITY_FILE || defaultSudoIdentity;
  yield* validateOwnerFileMode(identityFile, `missing ${identityFile}`);

  const age = yield* findFixedExecutable([
    "/opt/homebrew/bin/age",
    "/usr/local/bin/age",
    "/usr/bin/age",
  ]);

  if (!age) {
    return yield* fail("missing age");
  }

  const fs = yield* FileSystem.FileSystem;
  const tmpBase = (process.env.TMPDIR || "/tmp").replace(/\/$/, "") || "/";

  if (!isAbsolute(tmpBase) || !(yield* fs.exists(tmpBase))) {
    return yield* fail("invalid temporary directory");
  }

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: tmpBase,
        prefix: "dotfiles-sudo.",
      });

      yield* fs.chmod(temporary, 0o700);
      const ciphertextFile = join(temporary, "password.age");
      yield* fs.writeFileString(ciphertextFile, `${ciphertext}\n`, { mode: 0o600 });

      if (!nested) {
        const result = yield* runRaw("/usr/bin/sudo", ["-k", "-A", "-p", "", "--", ...args], {
          env: sanitizedEnvironment({
            SUDO_ASKPASS: askpass,
            SUDO_AGE_BIN: age,
            SUDO_AGE_IDENTITY_FILE: identityFile,
            SUDO_AGE_CIPHERTEXT_FILE: ciphertextFile,
          }),
          extendEnv: false,
        });

        if (result.status !== 0) {
          return yield* fail(`sudo command exited ${result.status}`, result.status);
        }

        return;
      }

      const nestedAskpass = join(temporary, "askpass");
      yield* fs.copyFile(askpass, nestedAskpass);
      yield* fs.chmod(nestedAskpass, 0o700);
      yield* fs.symlink(age, join(temporary, "age"));
      yield* fs.symlink(identityFile, join(temporary, "identity"));
      const env = sanitizedEnvironment({ SUDO_ASKPASS: nestedAskpass });

      const validated = yield* runRaw("/usr/bin/sudo", ["-k", "-A", "-p", "", "-v"], {
        env,
        extendEnv: false,
      });

      if (validated.status !== 0) {
        return yield* fail(`sudo validation exited ${validated.status}`, validated.status);
      }

      const child = yield* runRaw(args[0], args.slice(1), { env, extendEnv: false });

      if (child.status !== 0) {
        return yield* fail(`nested command exited ${child.status}`, child.status);
      }
    }),
  );
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const program = Effect.gen(function* () {
  const args = process.argv.slice(2);

  if (args[0] === "--consume-secret") {
    return yield* consumeSecret(args.slice(1));
  }

  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    yield* Console.log(usage);

    return;
  }

  if (args[0] === "--") {
    args.shift();
  }

  if (args.length === 0) {
    yield* Console.error(usage);

    return yield* fail("missing command", 2);
  }

  yield* validateOwnerFileMode(configPath, `missing ${configPath}`);
  const fs = yield* FileSystem.FileSystem;
  const config = yield* parseConfig(yield* fs.readFileString(configPath));
  const payloadInfo = yield* fs.stat(config.SOPS_SUDO_SECRET_FILE).pipe(Effect.option);

  if (Option.isNone(payloadInfo) || payloadInfo.value.type !== "File") {
    return yield* fail(`missing SOPS payload: ${config.SOPS_SUDO_SECRET_FILE}`);
  }

  const sudoIdentity =
    process.env.SUDO_AGE_IDENTITY_FILE || config.SUDO_AGE_IDENTITY_FILE || defaultSudoIdentity;

  const sopsIdentity = ageIdentityPath();
  const identityInfo = yield* fs.stat(sopsIdentity).pipe(Effect.option);

  if (Option.isNone(identityInfo) || identityInfo.value.type !== "File") {
    return yield* fail(`missing SOPS age identity: ${sopsIdentity}`);
  }

  const sops =
    process.env.SOPS_BINARY ||
    (yield* findFixedExecutable([
      "/opt/homebrew/bin/sops",
      "/usr/local/bin/sops",
      "/usr/bin/sops",
    ]));

  if (!sops) {
    return yield* fail("missing sops");
  }

  const command = [
    process.execPath,
    join(repoRoot, "identity/sops-devbox-sudo.ts"),
    "--consume-secret",
    ...args,
  ]
    .map(shellQuote)
    .join(" ");

  const result = yield* runRaw(
    sops,
    ["exec-env", "--same-process", config.SOPS_SUDO_SECRET_FILE, command],
    {
      env: { SOPS_AGE_KEY_FILE: sopsIdentity, SUDO_AGE_IDENTITY_FILE: sudoIdentity },
    },
  );

  if (result.status !== 0) {
    return yield* fail(`sops exec-env exited ${result.status}`, result.status);
  }
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
