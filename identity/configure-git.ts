#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema, Terminal } from "effect";
import { dirname, join } from "node:path";
import { CommandRunner, runCommand } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { normalizeProfile, profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";
import type { ProfileConfig } from "../profiles/model.ts";

const usage = `usage: identity/configure-git.ts [--profile developer|devbox|workstation|personal-devbox|personal-workstation] [--non-interactive]

Personal and devbox/workstation profiles configure human
identity.

Writes:
  ~/.gitconfig.local
  ~/.ssh/github.config when GIT_SSH_IDENTITY_FILE is set or inferred

Environment:
  GIT_USER_NAME
  GIT_USER_EMAIL
  GIT_SIGNING_KEY    unencrypted local SSH private key path
  GIT_SIGN_COMMITS    true|false
  GIT_ALLOWED_SIGNER_PRINCIPAL optional SSH signing verification principal; defaults to GIT_USER_EMAIL
  GIT_SSH_IDENTITY_FILE optional SSH private key path for git@github.com; devbox defaults to GIT_SIGNING_KEY
`;

const PrivateKeyHeader = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----$/)),
);

type Arguments = { readonly profile?: string; readonly nonInteractive: boolean };

const parseArguments = Effect.fn("parseConfigureGitArguments")(function* (
  args: ReadonlyArray<string>,
): Effect.fn.Return<Arguments, CliFailure> {
  let profile: string | undefined;
  let nonInteractive = false;
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--profile": {
        const value = args[index + 1];
        if (!value || profile !== undefined) {
          return yield* fail("--profile requires one value", 2);
        }
        profile = value;
        index += 1;
        break;
      }
      case "--non-interactive":
        nonInteractive = true;
        break;
      default:
        return yield* fail(`unknown argument: ${args[index]}`, 2);
    }
  }
  return { profile, nonInteractive };
});

const run = Effect.fn("runCheckedConfigureGitCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  message?: string,
) {
  const result = yield* runCommand(command, args);
  if (result.status !== 0) {
    return yield* fail(message || `${command} exited ${result.status}`, result.status);
  }
  return result.stdout.trimEnd();
});

const prompt = Effect.fn("promptConfigureGit")(function* (
  label: string,
  fallback: string,
  nonInteractive: boolean,
) {
  if (nonInteractive) {
    return fallback;
  }
  const suffix = fallback ? ` [${fallback}]: ` : ": ";
  yield* Effect.sync(() => process.stderr.write(`${label}${suffix}`));
  const terminal = yield* Terminal.Terminal;
  const value = yield* terminal.readLine.pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 1, message: "input cancelled" })),
  );
  return value || fallback;
});

const resolveSelectedProfile = Effect.fn("resolveConfigureGitProfile")(function* (args: Arguments) {
  if (args.profile !== undefined) {
    return yield* normalizeProfile(args.profile).pipe(
      Effect.mapError(
        () => new CliFailure({ exitCode: 2, message: `unsupported profile: ${args.profile}` }),
      ),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const marker = join(process.env.HOME || "", ".config/dotfiles/profile");
  const markerExists = yield* fs.exists(marker);
  const markerLink = yield* fs.readLink(marker).pipe(Effect.option);
  if (markerExists || Option.isSome(markerLink) || process.env.DOTFILES_PROFILE !== undefined) {
    return yield* resolveProfile(undefined).pipe(
      Effect.mapError(
        () => new CliFailure({ exitCode: 2, message: "stored or environment profile is invalid" }),
      ),
    );
  }
  const selected = yield* prompt(
    "Profile (personal-workstation/personal-devbox/workstation/devbox)",
    "workstation",
    args.nonInteractive,
  );
  return yield* normalizeProfile(selected).pipe(
    Effect.mapError(
      () => new CliFailure({ exitCode: 2, message: `unsupported profile: ${selected}` }),
    ),
  );
});

const validatePrivateKey = Effect.fn("validateLocalSshPrivateKey")(function* (
  purpose: string,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") {
    return yield* fail(`cannot configure ${purpose}; key file does not exist: ${path}`);
  }
  const readable = yield* fs.access(path, { readable: true }).pipe(Effect.option);
  if (Option.isNone(readable)) {
    return yield* fail(`cannot configure ${purpose}; key file is not readable: ${path}`);
  }
  const firstLine = (yield* fs.readFileString(path)).split(/\r?\n/, 1)[0];
  const header = yield* Schema.decodeUnknownEffect(PrivateKeyHeader)(firstLine).pipe(Effect.option);
  if (Option.isNone(header)) {
    return yield* fail(`cannot configure ${purpose}; key file is not an SSH private key: ${path}`);
  }
  const parsed = yield* runCommand("ssh-keygen", ["-lf", path]);
  if (parsed.status !== 0) {
    return yield* fail(
      `cannot configure ${purpose}; key file is not a valid SSH private key: ${path}`,
    );
  }
  if (Option.getOrUndefined(info.value.uid) !== process.getuid?.()) {
    return yield* fail(
      `cannot configure ${purpose}; key file is not owned by the current user: ${path}`,
    );
  }
  if ((info.value.mode & 0o077) !== 0) {
    return yield* fail(
      `cannot configure ${purpose}; key file permissions must be owner-only: ${path} (mode ${(info.value.mode & 0o777).toString(8)})\nrun: chmod 0600 ${path}`,
    );
  }
});

function validateExclusiveManagedBlock(contents: string): boolean {
  let managed = false;
  let blocks = 0;
  let unmanaged = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line === "# dotfiles: github-ssh begin") {
      if (managed || blocks > 0) {
        return false;
      }
      managed = true;
      blocks += 1;
    } else if (line === "# dotfiles: github-ssh end") {
      if (!managed) {
        return false;
      }
      managed = false;
    } else if (!managed && line.trim()) {
      unmanaged = true;
    }
  }
  return !managed && blocks === 1 && !unmanaged;
}

function validateManagedMarkers(contents: string): boolean {
  let managed = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line === "# dotfiles: github-ssh begin") {
      if (managed) {
        return false;
      }
      managed = true;
    } else if (line === "# dotfiles: github-ssh end") {
      if (!managed) {
        return false;
      }
      managed = false;
    }
  }
  return !managed;
}

function hasUnmanagedGithubHost(contents: string): boolean {
  let managed = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    if (rawLine === "# dotfiles: github-ssh begin") {
      managed = true;
      continue;
    }
    if (rawLine === "# dotfiles: github-ssh end") {
      managed = false;
      continue;
    }
    if (managed) {
      continue;
    }
    const line = rawLine.trimStart();
    const match = /^host[\s=]+([^#]*)/i.exec(line);
    if (
      match?.[1]
        ?.trim()
        .split(/\s+/)
        .some((pattern) => pattern.toLowerCase() === "github.com")
    ) {
      return true;
    }
  }
  return false;
}

const validateGithubSshConfig = Effect.fn("validateGithubSshConfig")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const local = join(home, ".ssh/config.local");
  const github = join(home, ".ssh/github.config");
  const githubLink = yield* fs.readLink(github).pipe(Effect.option);
  if (Option.isSome(githubLink)) {
    return yield* fail(
      `cannot configure git@github.com SSH auth; existing path is a symlink: ${github}\nmove it aside before rerunning configure-git.ts`,
    );
  }
  const githubInfo = yield* fs.stat(github).pipe(Effect.option);
  if (Option.isSome(githubInfo) && githubInfo.value.type !== "File") {
    return yield* fail(
      `cannot configure git@github.com SSH auth; existing path is not a regular file: ${github}\nmove it aside before rerunning configure-git.ts`,
    );
  }
  if (Option.isSome(githubInfo)) {
    const contents = yield* fs.readFileString(github);
    if (!validateExclusiveManagedBlock(contents)) {
      return yield* fail(
        `cannot configure git@github.com SSH auth; existing file is not managed exclusively by these dotfiles: ${github}\nmove it aside or migrate its directives to ~/.ssh/config.local before rerunning configure-git.ts`,
      );
    }
  }
  const localInfo = yield* fs.stat(local).pipe(Effect.option);
  if (Option.isNone(localInfo) || localInfo.value.type !== "File") {
    return;
  }
  const contents = yield* fs.readFileString(local);
  if (!validateManagedMarkers(contents)) {
    return yield* fail(
      `cannot configure git@github.com SSH auth; malformed managed block in ${local}`,
    );
  }
  if (hasUnmanagedGithubHost(contents)) {
    return yield* fail(
      `cannot configure git@github.com SSH auth; unmanaged Host github.com entry exists in ${local}\nremove or migrate that entry before rerunning configure-git.ts`,
    );
  }
});

const writeGithubSshConfig = Effect.fn("writeGithubSshConfig")(function* (
  home: string,
  identityFile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const sshDir = join(home, ".ssh");
  const target = join(sshDir, "github.config");
  yield* fs.makeDirectory(sshDir, { recursive: true });
  yield* fs.chmod(sshDir, 0o700);
  const temporary = yield* fs.makeTempFile({ directory: sshDir, prefix: ".github.config." });
  yield* fs.writeFileString(
    temporary,
    `# dotfiles: github-ssh begin
Host github.com
  HostName github.com
  User git
  IdentityFile ${identityFile}
  IdentitiesOnly yes
  IdentityAgent none
  AddKeysToAgent no
# dotfiles: github-ssh end
`,
  );
  yield* fs.chmod(temporary, 0o600);
  yield* fs.rename(temporary, target);
  yield* Console.log(`wrote ${target}`);
});

const getGlobal = Effect.fn("getGlobalGitConfig")(function* (key: string) {
  const result = yield* runCommand("git", ["config", "--global", "--get", key]);
  return result.status === 0 ? result.stdout.trimEnd() : "";
});

const buildConfiguration = Effect.fn("buildGitConfiguration")(function* (
  args: Arguments,
  profile: string,
  config: ProfileConfig,
) {
  const home = process.env.HOME || "";
  let name = process.env.GIT_USER_NAME || "";
  let email = process.env.GIT_USER_EMAIL || "";
  let signingKey = process.env.GIT_SIGNING_KEY || "";
  let signCommits = process.env.GIT_SIGN_COMMITS || "";
  let sshIdentity = process.env.GIT_SSH_IDENTITY_FILE || "";
  if (config.capabilities.devbox && !signCommits) {
    signCommits = "true";
  }
  const defaultName = yield* getGlobal("user.name");
  const defaultEmail = yield* getGlobal("user.email");
  if (!name) {
    name = yield* prompt("Git user.name", defaultName, args.nonInteractive);
  }
  if (!email) {
    email = yield* prompt("Git user.email", defaultEmail, args.nonInteractive);
  }
  if (!name || !email) {
    return yield* fail("git user.name and user.email are required");
  }
  if (!signingKey && signCommits !== "false") {
    signingKey = yield* prompt(
      "Git SSH private key path (blank to disable signing)",
      "",
      args.nonInteractive,
    );
  }
  if (!signCommits) {
    signCommits = signingKey ? "true" : "false";
  }
  if (signCommits !== "true" && signCommits !== "false") {
    return yield* fail("GIT_SIGN_COMMITS must be true or false", 2);
  }
  if (signCommits === "true" && !signingKey) {
    return yield* fail(
      "commit signing is enabled but GIT_SIGNING_KEY is empty\nset GIT_SIGNING_KEY to an unencrypted local SSH private key, or set GIT_SIGN_COMMITS=false",
    );
  }
  let publicKey = "";
  if (signCommits === "true") {
    yield* validatePrivateKey("Git signing", signingKey);
    const publicKeyResult = yield* runCommand("ssh-keygen", ["-y", "-P", "", "-f", signingKey]);
    if (publicKeyResult.status !== 0) {
      return yield* fail(
        `cannot configure Git signing; GIT_SIGNING_KEY must be an unencrypted SSH private key: ${signingKey}`,
      );
    }
    publicKey = publicKeyResult.stdout.trim();
    const signer = join(home, ".local/libexec/dotfiles/git-ssh-sign-agentless");
    const fs = yield* FileSystem.FileSystem;
    const signerInfo = yield* fs.stat(signer).pipe(Effect.option);
    if (
      Option.isNone(signerInfo) ||
      signerInfo.value.type !== "File" ||
      (signerInfo.value.mode & 0o111) === 0
    ) {
      return yield* fail(
        `cannot configure Git signing; agentless signer is missing or not executable: ${signer}\nrun bootstrap/install.ts before configure-git.ts`,
      );
    }
  }
  if (!sshIdentity && config.capabilities.devbox) {
    sshIdentity = signingKey;
  }
  if (sshIdentity) {
    yield* validatePrivateKey("git@github.com SSH auth", sshIdentity);
    yield* validateGithubSshConfig(home);
  }
  return { name, email, signingKey, signCommits, sshIdentity, publicKey } as const;
});

const program = Effect.gen(function* () {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 1 && (rawArgs[0] === "-h" || rawArgs[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const args = yield* parseArguments(rawArgs).pipe(Effect.tapError(() => Console.error(usage)));
  const profile = yield* resolveSelectedProfile(args);
  const model = yield* readProfileModelEffect(profileModelFile()).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
  );
  const profileConfig = requireProfile(model, profile);
  const values = yield* buildConfiguration(args, profile, profileConfig);
  const home = process.env.HOME || "";
  const fs = yield* FileSystem.FileSystem;
  const gitconfig = join(home, ".gitconfig.local");
  const signers = join(home, ".config/git/allowed_signers.local");
  const signerProgram = join(home, ".local/libexec/dotfiles/git-ssh-sign-agentless");

  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempFileScoped({ prefix: "dotfiles-gitconfig." });
      for (const [key, value] of [
        ["user.name", values.name],
        ["user.email", values.email],
        ["commit.gpgsign", values.signCommits],
        ["tag.gpgsign", values.signCommits],
      ] as const) {
        yield* run("git", ["config", "--file", temporary, key, value]);
      }
      if (values.signCommits === "true") {
        yield* run("git", ["config", "--file", temporary, "user.signingkey", values.signingKey]);
        yield* run("git", ["config", "--file", temporary, "gpg.ssh.allowedSignersFile", signers]);
        yield* run("git", ["config", "--file", temporary, "gpg.ssh.program", signerProgram]);
      }
      if (profileConfig.capabilities.devbox && process.platform === "darwin") {
        yield* run("git", ["config", "--file", temporary, "safe.directory", "/opt/homebrew"]);
      }

      if (values.sshIdentity) {
        yield* writeGithubSshConfig(home, values.sshIdentity);
      }
      if (values.signCommits === "true") {
        yield* fs.makeDirectory(dirname(signers), { recursive: true });
        const temporarySigners = yield* fs.makeTempFileScoped({
          directory: dirname(signers),
          prefix: ".allowed-signers.",
        });
        yield* fs.writeFileString(
          temporarySigners,
          `${process.env.GIT_ALLOWED_SIGNER_PRINCIPAL || values.email} ${values.publicKey}\n`,
        );
        yield* fs.chmod(temporarySigners, 0o600);
        yield* fs.rename(temporarySigners, signers);
        yield* Console.log(`wrote ${signers}`);
      }
      const link = yield* fs.readLink(gitconfig).pipe(Effect.option);
      if (Option.isSome(link)) {
        yield* fs.remove(gitconfig, { force: true });
      }
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, gitconfig);
    }),
  );
  yield* Console.log(`wrote ${gitconfig}`);
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
