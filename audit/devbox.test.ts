#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { devboxPolicy } from "./devbox.ts";
import { runPolicy } from "./engine.ts";

function command(command: string, args: ReadonlyArray<string>) {
  if (command === "git") {
    const key = args.at(-1);

    const values = new Map([
      ["user.name", "Fixture"],
      ["user.email", "fixture@example.invalid"],
      ["user.signingkey", "fixture-key"],
      ["commit.gpgsign", "true"],
    ]);

    const value = values.get(key ?? "");

    return { status: value ? 0 : 1, stdout: value ?? "", stderr: "" };
  }

  if (command === "gh") {
    return { status: 0, stdout: "", stderr: "Token scopes: 'repo'\n" };
  }

  if (command === "ssh") {
    return { status: 1, stdout: "", stderr: "successfully authenticated" };
  }

  if (command === "tailscale" && args.includes("--json")) {
    return {
      status: 0,
      stdout: JSON.stringify({ Self: { DNSName: "fixture.tail.example." } }),
      stderr: "",
    };
  }

  if (command === "dig") {
    return { status: 0, stdout: "100.64.0.1\n", stderr: "" };
  }

  if (command === "dscacheutil") {
    return { status: 0, stdout: "ip_address: 100.64.0.1\n", stderr: "" };
  }

  if (command === "gitleaks" && args[0] === "dir") {
    writeFileSync(args[args.indexOf("--report-path") + 1], "[]");
  }

  return { status: 0, stdout: "", stderr: "" };
}

test("devbox policy passes a private, correctly scoped fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-devbox-audit-"));
  const home = join(root, "home");
  const systemRoot = join(root, "system");
  const project = join(home, "projects/fixture/repo");
  const config = join(home, ".config/dotfiles/devbox.env");

  try {
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(join(systemRoot, "Library"), { recursive: true });
    mkdirSync(join(home, ".config/dotfiles"), { recursive: true });
    chmodSync(join(home, ".codex"), 0o700);
    chmodSync(join(home, "projects"), 0o700);
    chmodSync(join(home, "projects/fixture"), 0o700);
    writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
    writeFileSync(join(home, ".ssh/config.local"), "Host fixture\n", { mode: 0o600 });
    writeFileSync(
      join(home, ".codex/config.toml"),
      `[projects."${project}"]\ntrust_level = "trusted"\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=fixture\n", {
      mode: 0o600,
    });
    writeFileSync(config, "DEVBOX_USER=fixture\n", { mode: 0o600 });

    const result = runPolicy(devboxPolicy("fixture", "fixture", config, systemRoot), "json", {
      home,
      env: { HOME: home, USER: "fixture", TMPDIR: join(root, "tmp") },
      command,
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(result.status, 0);
    assert.equal(result.summary.status, "pass");
    assert.equal(result.summary.user, "fixture");
    assert.equal(result.summary.devbox_user, "fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("devbox policy rejects another user's Codex trust", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-devbox-trust-"));
  const home = join(root, "users/fixture");
  const config = join(home, ".codex/config.toml");

  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(config, `[projects."${join(root, "users/other/repo")}"]\n`, { mode: 0o600 });

    const policy = {
      name: "fixture",
      summary: "fixture",
      sections: [{ title: "trust", checks: [{ kind: "codex-trust", path: ".codex/config.toml" }] }],
    } as const;

    const result = runPolicy(policy, "json", { home, command, stdout: () => {}, stderr: () => {} });
    assert.equal(result.status, 1);
    assert.equal(result.summary.failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("devbox Git identity keeps separate missing-field failures", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-devbox-git-"));

  try {
    const policy = {
      name: "fixture",
      summary: "fixture",
      sections: [
        {
          title: "git",
          checks: [
            { kind: "git-identity", config: ".gitconfig", missing: "fail", identity: "separate" },
          ],
        },
      ],
    } as const;

    const result = runPolicy(policy, "json", {
      home: root,
      command: (name, args) =>
        name === "git" && args.at(-1) === "commit.gpgsign"
          ? { status: 1, stdout: "false", stderr: "" }
          : { status: 1, stdout: "", stderr: "" },
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(result.summary.failed, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MagicDNS reports a failed JSON status command", () => {
  const policy = {
    name: "fixture",
    summary: "fixture",
    sections: [{ title: "tailscale", checks: [{ kind: "tailscale-magicdns" }] }],
  } as const;

  const result = runPolicy(policy, "json", {
    home: "/fixture",
    command: (_name, args) =>
      args.includes("--json")
        ? { status: 1, stdout: "", stderr: "status unavailable" }
        : { status: 0, stdout: "", stderr: "" },
    stdout: () => {},
    stderr: () => {},
  });

  assert.equal(result.status, 1);
  assert.equal(result.summary.failed, 1);
});
