#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configurator = join(repoRoot, "identity/configure-git.ts");
const signerSource = join(
  repoRoot,
  "chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_git-ssh-sign-agentless",
);

const program = Effect.scoped(
  Effect.gen(function* () {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_") && !["GIT_USER_NAME", "GIT_USER_EMAIL"].includes(key)) {
        delete process.env[key];
      }
    }
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-configure-git." });
    const run = (
      command: string,
      args: ReadonlyArray<string>,
      env: Readonly<Record<string, string>> = {},
    ) => runner.run(command, args, { env });
    const makeHome = Effect.fn("makeGitFixtureHome")(function* (name: string, encrypted = false) {
      const home = join(temporary, name);
      const signer = join(home, ".local/libexec/dotfiles/git-ssh-sign-agentless");
      yield* fs.makeDirectory(join(home, ".colima"), { recursive: true });
      yield* fs.makeDirectory(join(home, ".ssh/config.d"), { recursive: true });
      yield* fs.makeDirectory(dirname(signer), { recursive: true });
      yield* fs.writeFileString(join(home, ".colima/ssh_config"), "");
      yield* fs.copyFile(signerSource, signer);
      yield* fs.chmod(signer, 0o700);
      assert.equal(
        (yield* run("git", ["config", "--global", "gpg.format", "ssh"], { HOME: home })).status,
        0,
      );
      assert.equal(
        (yield* run("git", ["config", "--global", "include.path", join(home, ".gitconfig.local")], {
          HOME: home,
        })).status,
        0,
      );
      const rendered = yield* runner.run("chezmoi", [
        "--source",
        join(repoRoot, "chezmoi"),
        "--destination",
        home,
        "--override-data",
        '{"dotfilesProfile":"devbox"}',
        "cat",
        join(home, ".ssh/config"),
      ]);
      assert.equal(rendered.status, 0, rendered.stderr);
      const ssh = rendered.stdout
        .replaceAll("~/.ssh", `${home}/.ssh`)
        .replaceAll("~/.colima", `${home}/.colima`);
      yield* fs.writeFileString(join(home, ".ssh/config"), ssh, { mode: 0o600 });
      const key = join(home, ".ssh/signing");
      const generated = yield* run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        encrypted ? "fixture-passphrase" : "",
        "-f",
        key,
      ]);
      assert.equal(generated.status, 0, generated.stderr);
      return { home, key, signer };
    });
    const configure = (
      home: string,
      profile: string,
      signingKey: string,
      identity = signingKey,
      extra: Readonly<Record<string, string>> = {},
    ) =>
      run(process.execPath, [configurator, "--profile", profile, "--non-interactive"], {
        HOME: home,
        GIT_USER_NAME: "Example User",
        GIT_USER_EMAIL: "example@example.com",
        GIT_SIGNING_KEY: signingKey,
        GIT_SSH_IDENTITY_FILE: identity,
        GIT_SIGN_COMMITS: "true",
        ...extra,
      });
    const renderSsh = Effect.fn("renderSshConfig")(function* (data: string) {
      const rendered = yield* runner.run("chezmoi", [
        "--source",
        join(repoRoot, "chezmoi"),
        "--destination",
        temporary,
        "--override-data",
        data,
        "cat",
        join(temporary, ".ssh/config"),
      ]);
      assert.equal(rendered.status, 0, rendered.stderr);
      return rendered.stdout;
    });
    const source = yield* renderSsh('{"dotfilesProfile":"devbox"}');
    assert.equal(source.split("\n")[0], "Include ~/.ssh/github.config");
    assert.match(source, /^Include ~\/\.ssh\/config\.d\/\*\.conf$/m);
    const darwin = yield* renderSsh('{"dotfilesProfile":"devbox","chezmoi":{"os":"darwin"}}');
    assert.match(darwin, /^Include ~\/\.colima\/ssh_config$/m);
    const linux = yield* renderSsh('{"dotfilesProfile":"devbox","chezmoi":{"os":"linux"}}');
    assert.doesNotMatch(linux, /colima/);

    const personal = yield* makeHome("personal");
    yield* fs.writeFileString(
      join(personal.home, ".ssh/config.local"),
      `Host unrelated.example\n  User example\n\nHost *\n  IdentityAgent /tmp/preexisting-agent.sock\n  IdentityFile /tmp/preexisting-identity\n`,
    );
    const configured = yield* configure(personal.home, "personal-workstation", personal.key);
    assert.equal(configured.status, 0, configured.stderr);
    const local = join(personal.home, ".gitconfig.local");
    assert.equal(
      (yield* run("git", ["config", "--file", local, "--get", "user.signingkey"])).stdout.trim(),
      personal.key,
    );
    assert.equal(
      (yield* run("git", ["config", "--file", local, "--get", "gpg.ssh.program"])).stdout.trim(),
      personal.signer,
    );
    assert.match(yield* fs.readFileString(personal.signer), /^unset SSH_AUTH_SOCK$/m);
    const github = join(personal.home, ".ssh/github.config");
    assert.equal(
      (yield* fs.readFileString(github)).match(/^# dotfiles: github-ssh begin$/gm)?.length,
      1,
    );
    const before = createHash("sha256")
      .update(yield* fs.readFile(github))
      .digest("hex");
    assert.equal((yield* configure(personal.home, "workstation", personal.key)).status, 0);
    assert.equal(
      createHash("sha256")
        .update(yield* fs.readFile(github))
        .digest("hex"),
      before,
    );
    const effective = yield* run("ssh", [
      "-F",
      join(personal.home, ".ssh/config"),
      "-G",
      "github.com",
    ]);
    assert.match(effective.stdout, /^identityagent none$/m);
    assert.match(effective.stdout, /^identityfile .*\/\.ssh\/signing$/m);

    const proof = join(personal.home, "proof");
    assert.equal((yield* run("git", ["init", "-q", proof], { HOME: personal.home })).status, 0);
    yield* fs.writeFileString(join(proof, "proof.txt"), "agentless signing proof\n");
    assert.equal(
      (yield* run("git", ["-C", proof, "add", "proof.txt"], { HOME: personal.home })).status,
      0,
    );
    const commit = yield* run(
      "git",
      ["-C", proof, "commit", "-q", "-m", "test: prove agentless signing"],
      { HOME: personal.home },
    );
    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(
      (yield* run("git", ["-C", proof, "verify-commit", "HEAD"], { HOME: personal.home })).status,
      0,
    );

    const encrypted = yield* makeHome("encrypted", true);
    const encryptedResult = yield* configure(encrypted.home, "personal-workstation", encrypted.key);
    assert.equal(encryptedResult.status, 1);
    assert.match(encryptedResult.stderr, /must be an unencrypted SSH private key/);
    const permissive = yield* makeHome("permissive");
    yield* fs.chmod(permissive.key, 0o644);
    const permissiveResult = yield* configure(
      permissive.home,
      "personal-workstation",
      permissive.key,
    );
    assert.equal(permissiveResult.status, 1);
    assert.match(permissiveResult.stderr, /permissions must be owner-only/);
    const invalid = yield* makeHome("invalid");
    yield* fs.writeFileString(invalid.key, "not a private key\n", { mode: 0o600 });
    const invalidResult = yield* configure(invalid.home, "personal-workstation", invalid.key);
    assert.equal(invalidResult.status, 1);
    assert.match(invalidResult.stderr, /key file is not an SSH private key/);

    yield* Console.log("ok Git bootstrap preserves developer signing");
  }).pipe(
    Effect.catchCause((cause) => fail(Cause.pretty(cause))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);
runMain(program);
