#!/usr/bin/env node

import { ageIdentityPath } from "./age.ts";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join } from "node:path";
import { CommandRunner, runCommand } from "../lib/command.ts";
import { commandAvailable } from "../lib/command-available.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const usage = `Usage:
  identity/configure-sops-age-identity.ts
  identity/configure-sops-age-identity.ts --check
  identity/configure-sops-age-identity.ts --print-recipient

Creates or verifies the current Unix user's private age identity at the path
SOPS uses by default. Set SOPS_AGE_KEY_FILE to use an explicit owner-only path.`;
const Recipient = Schema.String.pipe(Schema.check(Schema.isPattern(/^age1[0-9a-z]+$/)));
const Version = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+].*)?$/)),
);
type Mode = "provision" | "check" | "print-recipient";

const parseMode = Effect.fn("parseSopsIdentityMode")(function* (
  args: readonly string[],
): Effect.fn.Return<Mode, CliFailure> {
  if (args.length === 0) {
    return "provision";
  }
  if (args.length === 1 && args[0] === "--check") {
    return "check";
  }
  if (args.length === 1 && args[0] === "--print-recipient") {
    return "print-recipient";
  }
  return yield* fail("invalid arguments", 2);
});

const runRaw = Effect.fn("runSopsIdentityCommand")(function* (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly extendEnv?: boolean;
  } = {},
) {
  return yield* runCommand(command, args, options);
});

const validateIdentity = Effect.fn("validateSopsAgeIdentity")(function* (identityFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const identityDir = dirname(identityFile);
  const directoryLink = yield* fs.readLink(identityDir).pipe(Effect.option);
  const directory = yield* fs.stat(identityDir).pipe(Effect.option);
  if (Option.isNone(directory) || directory.value.type !== "Directory") {
    return yield* fail(`missing identity directory: ${identityDir}`);
  }
  if (Option.isSome(directoryLink)) {
    return yield* fail(`identity directory must not be a symlink: ${identityDir}`);
  }
  const fileLink = yield* fs.readLink(identityFile).pipe(Effect.option);
  const file = yield* fs.stat(identityFile).pipe(Effect.option);
  if (Option.isNone(file) || file.value.type !== "File") {
    return yield* fail(`missing age identity: ${identityFile}`);
  }
  if (Option.isSome(fileLink)) {
    return yield* fail(`age identity must not be a symlink: ${identityFile}`);
  }
  const uid = process.getuid?.();
  if (Option.getOrUndefined(directory.value.uid) !== uid) {
    return yield* fail(`identity directory is not owned by the current user: ${identityDir}`);
  }
  if (Option.getOrUndefined(file.value.uid) !== uid) {
    return yield* fail(`age identity is not owned by the current user: ${identityFile}`);
  }
  if ((directory.value.mode & 0o777) !== 0o700) {
    return yield* fail(`identity directory must have mode 0700: ${identityDir}`);
  }
  if ((file.value.mode & 0o777) !== 0o600) {
    return yield* fail(`age identity must have mode 0600: ${identityFile}`);
  }
  const derived = yield* runRaw("age-keygen", ["-y", identityFile]);
  if (derived.status !== 0) {
    return yield* fail(`age-keygen could not derive a recipient from ${identityFile}`);
  }
  return yield* Schema.decodeUnknownEffect(Recipient)(derived.stdout.trim()).pipe(
    Effect.mapError(
      () =>
        new CliFailure({ exitCode: 1, message: "age-keygen returned an invalid public recipient" }),
    ),
  );
});

const validateSopsVersion = Effect.fn("validateSopsVersion")(function* () {
  const result = yield* runRaw("sops", ["--version"]);
  if (result.status !== 0) {
    return yield* fail("could not determine the SOPS version");
  }
  const token = result.stdout.split(/\r?\n/, 1)[0]?.trim().split(/\s+/)[1];
  const version = yield* Schema.decodeUnknownEffect(Version)(token).pipe(
    Effect.mapError(
      () =>
        new CliFailure({
          exitCode: 1,
          message: `could not parse the SOPS version: ${token || "missing"}`,
        }),
    ),
  );
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 9)) {
    return yield* fail(`SOPS 3.9.0 or newer is required; found ${version}`);
  }
});

const verifyRoundTrip = Effect.fn("verifySopsAgeRoundTrip")(function* (
  identityFile: string,
  recipient: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-sops-age." });
      yield* fs.chmod(temporary, 0o700);
      const plaintext = join(temporary, "probe.env");
      const encrypted = join(temporary, "probe.sops.env");
      const expected = "DOTFILES_SOPS_PROBE=ok";
      yield* fs.writeFileString(plaintext, `${expected}\n`, { mode: 0o600 });
      const encryption = yield* runRaw(
        "sops",
        [
          "encrypt",
          "--age",
          recipient,
          "--input-type",
          "dotenv",
          "--output-type",
          "dotenv",
          plaintext,
        ],
        { cwd: temporary },
      );
      if (encryption.status !== 0) {
        return yield* fail("SOPS could not encrypt to the generated recipient");
      }
      yield* fs.writeFileString(encrypted, encryption.stdout, { mode: 0o600 });
      const decryption = yield* runRaw(
        "sops",
        ["decrypt", "--input-type", "dotenv", "--output-type", "dotenv", encrypted],
        {
          env: { PATH: process.env.PATH || "", SOPS_AGE_KEY_FILE: identityFile },
          extendEnv: false,
        },
      );
      if (decryption.status !== 0) {
        return yield* fail(`SOPS could not decrypt with ${identityFile}`);
      }
      if (decryption.stdout.trimEnd() !== expected) {
        return yield* fail("SOPS age identity round trip changed the probe payload");
      }
    }),
  );
});

const provision = Effect.fn("provisionSopsAgeIdentity")(function* (identityFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const identityDir = dirname(identityFile);
  const directoryLink = yield* fs.readLink(identityDir).pipe(Effect.option);
  const directory = yield* fs.stat(identityDir).pipe(Effect.option);
  if (Option.isSome(directory) || Option.isSome(directoryLink)) {
    if (
      Option.isSome(directoryLink) ||
      Option.isNone(directory) ||
      directory.value.type !== "Directory"
    ) {
      return yield* fail(`refusing to use non-directory identity path: ${identityDir}`);
    }
    if (Option.getOrUndefined(directory.value.uid) !== process.getuid?.()) {
      return yield* fail(
        `refusing to change identity directory owned by another user: ${identityDir}`,
      );
    }
  } else {
    yield* fs.makeDirectory(identityDir, { recursive: true, mode: 0o700 });
  }
  const fileLink = yield* fs.readLink(identityFile).pipe(Effect.option);
  const file = yield* fs.stat(identityFile).pipe(Effect.option);
  if (Option.isSome(file) || Option.isSome(fileLink)) {
    if (Option.isSome(fileLink) || Option.isNone(file) || file.value.type !== "File") {
      return yield* fail(`refusing to replace non-regular age identity path: ${identityFile}`);
    }
  } else {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: identityDir,
          prefix: ".age-identity.",
        });
        const staged = join(staging, "keys.txt");
        const generated = yield* runRaw("age-keygen", ["-o", staged]);
        if (generated.status !== 0) {
          return yield* fail(`age-keygen could not create ${identityFile}`);
        }
        yield* fs.chmod(staged, 0o600);
        yield* fs
          .link(staged, identityFile)
          .pipe(
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              validateIdentity(identityFile).pipe(Effect.asVoid),
            ),
          );
      }),
    );
  }
  yield* fs.chmod(identityDir, 0o700);
  yield* fs.chmod(identityFile, 0o600);
});

const program = Effect.gen(function* () {
  const raw = process.argv.slice(2);
  if (raw.length === 1 && (raw[0] === "-h" || raw[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const mode = yield* parseMode(raw).pipe(Effect.tapError(() => Console.error(usage)));
  if (!(yield* commandAvailable("age-keygen"))) {
    return yield* fail("missing age-keygen");
  }
  const identityFile = ageIdentityPath();
  if (mode === "provision") {
    yield* provision(identityFile);
  }
  const recipient = yield* validateIdentity(identityFile);
  if (mode === "print-recipient") {
    yield* Console.log(recipient);
    return;
  }
  if (!(yield* commandAvailable("sops"))) {
    return yield* fail("missing sops");
  }
  yield* validateSopsVersion();
  yield* verifyRoundTrip(identityFile, recipient);
  yield* Console.log(`SOPS age identity ready: ${identityFile}`);
  yield* Console.log(`public recipient: ${recipient}`);
  yield* Console.log(
    mode === "provision"
      ? "backup required: save the private identity in the approved human recovery system before use"
      : "ok owner, permissions, recipient, and SOPS round trip",
  );
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
