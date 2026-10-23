#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  codexPrivateDirectories,
  codexPrivateFileDepth,
  codexPrivateFilePattern,
} from "../agents/codex/projects.ts";
import { runMain } from "../lib/program.ts";
import { type AuditFormat, type AuditPolicy, readSettingsFile, runPolicy } from "./engine.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import { compromisedRoots, projectEnvFiles } from "./workstation.ts";

const homeDotfiles = {
  kind: "home-dotfiles",
  exclude: [".CFUserTextEncoding", ".DS_Store", ".localized", ".npmrc"],
} as const;
const sshConfigs = { kind: "files", path: ".ssh", maxDepth: 0, namePrefix: "config" } as const;
const profileModelPath = fileURLToPath(
  new URL("../chezmoi/.chezmoidata/profiles.json", import.meta.url),
);

export function devboxPolicy(
  user: string,
  devboxUser: string,
  configPath: string,
  systemRoot = "/",
  profileName = "devbox",
): AuditPolicy {
  requireProfile(readProfileModel(profileModelPath), profileName);
  const codexPrivateSources = codexPrivateDirectories.map(
    (name) => ({ kind: "path", path: join(".codex", name) }) as const,
  );
  return {
    name: "devbox-security",
    summary: "devbox security audit summary",
    fields: { user, devbox_user: devboxUser },
    sections: [
      {
        title: "local devbox config",
        checks: [
          {
            kind: "file-mode",
            path: configPath,
            modes: [0o600],
            missing: "warn",
            mismatch: "fail",
          },
          {
            kind: "value-match",
            actual: devboxUser,
            expected: user,
            match: `devbox user matches current user: ${devboxUser}`,
            mismatch: `DEVBOX_USER is ${devboxUser} but current user is ${user}`,
            severity: "warn",
          },
        ],
      },
      {
        title: "local config secret scan",
        checks: [
          {
            kind: "secret-scan",
            sources: [
              homeDotfiles,
              { kind: "path", path: ".aws" },
              { kind: "path", path: ".docker" },
              { kind: "path", path: ".bash_sessions" },
              { kind: "path", path: ".zsh_sessions" },
              { kind: "path", path: "Library/LaunchAgents" },
              { kind: "path", path: join(systemRoot, "Library/LaunchDaemons") },
              sshConfigs,
            ],
          },
          { kind: "npm-auth-boundary", path: ".npmrc" },
          {
            kind: "pattern-absent",
            sources: [{ kind: "path", path: ".docker/config.json" }],
            pattern: /"auth"\s*:/,
            label: "inline Docker auth material",
            severity: "fail",
            countAsSecretScan: true,
          },
        ],
      },
      {
        title: "Codex private state",
        checks: [
          { kind: "private-mode", sources: codexPrivateSources, mode: 0o700, mismatch: "fail" },
          {
            kind: "private-mode",
            sources: [
              {
                kind: "files",
                path: ".codex",
                maxDepth: codexPrivateFileDepth,
                pathPattern: codexPrivateFilePattern,
              },
            ],
            mismatch: "fail",
          },
        ],
      },
      {
        title: "Codex trust boundaries",
        checks: [
          {
            kind: "private-mode",
            sources: [{ kind: "path", path: ".codex/config.toml" }],
            mode: 0o600,
            mismatch: "fail",
          },
          { kind: "codex-trust", path: ".codex/config.toml" },
        ],
      },
      {
        title: "home root pollution",
        checks: [
          {
            kind: "paths-absent",
            paths: [
              "node_modules",
              "package.json",
              "package-lock.json",
              "pnpm-lock.yaml",
              "yarn.lock",
            ],
            severity: "warn",
            label: "home root contains project artifact",
          },
        ],
      },
      {
        title: "project directory privacy",
        checks: [
          {
            kind: "private-mode",
            sources: [
              { kind: "path", path: "projects" },
              { kind: "path", path: `projects/${devboxUser}` },
            ],
            mismatch: "warn",
          },
        ],
      },
      { title: "project env file privacy", checks: [projectEnvFiles] },
      { title: "TLS trust store", checks: compromisedRoots(systemRoot) },
      {
        title: "Git and GitHub identity",
        checks: [
          { kind: "git-identity", config: ".gitconfig", missing: "fail", identity: "separate" },
          { kind: "github-auth" },
          { kind: "github-ssh-auth" },
        ],
      },
      {
        title: "SSH key file permissions",
        checks: [{ kind: "ssh-private-key-modes", path: ".ssh" }],
      },
      { title: "Tailscale", checks: [{ kind: "tailscale-magicdns" }] },
    ],
  };
}

function runDevbox(
  format: AuditFormat,
  explicitConfig = "",
  env: NodeJS.ProcessEnv = process.env,
): number {
  const home = env.HOME || "";
  const user = env.USER || "";
  const configPath =
    explicitConfig || env.DEVBOX_CONFIG || join(home, ".config/dotfiles/devbox.env");
  const config = existsSync(configPath) ? readSettingsFile(configPath) : {};
  const devboxUser = config.DEVBOX_USER || env.DEVBOX_USER || user;
  const profileName = readFileSync(join(home, ".config/dotfiles/profile"), "utf8").trim();
  return runPolicy(devboxPolicy(user, devboxUser, configPath, "/", profileName), format, {
    home,
    env,
  }).status;
}

function main(args: string[]): number {
  let format: AuditFormat = "text";
  let config = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json") format = "json";
    else if (args[index] === "--config" && args[index + 1]) config = args[++index];
    else {
      process.stderr.write("Usage: audit/devbox.ts [--config PATH] [--json]\n");
      return 2;
    }
  }
  return runDevbox(format, config);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMain(
    Effect.try({ try: () => main(process.argv.slice(2)), catch: (error) => error }).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          process.exitCode = status;
        }),
      ),
      Effect.asVoid,
    ),
  );
}
