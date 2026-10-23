#!/usr/bin/env node

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { type AuditFormat, type AuditPolicy, runPolicy } from "./engine.ts";

const homeDotfiles = {
  kind: "home-dotfiles",
  exclude: [".CFUserTextEncoding", ".DS_Store", ".localized", ".npmrc"],
} as const;
const sshConfigs = { kind: "files", path: ".ssh", maxDepth: 0, namePrefix: "config" } as const;
const launchAgents = { kind: "files", path: "Library/LaunchAgents" } as const;

// A .env copied from its example inherits the umask, so real env files can end
// up world-readable.
export const projectEnvFiles = {
  kind: "private-mode",
  sources: [
    {
      kind: "files",
      path: "projects",
      maxDepth: 5,
      namePrefix: ".env",
      pathPattern: /\/\.env(?![^/]*\.(?:example|sample|template)$)(?:\.[^/]+)?$/,
      skipDirectories: ["node_modules", ".git", "target", ".build"],
      ignoreDirectoryLinks: true,
    },
  ],
  mismatch: "warn",
} as const;

// The compromised eMudhra intermediates chain to these roots
// (https://emudhra.we-have-a-problem.com/). On macOS, curl, git and mise Python
// trust cert.pem, which macOS updates restore; Debian and Ubuntu build their
// bundle from the enabled ca-certificates.conf entries.
export function compromisedRoots(systemRoot: string) {
  const label = "roots of the compromised eMudhra intermediates";
  return [
    {
      kind: "pattern-absent",
      sources: [{ kind: "path", path: join(systemRoot, "etc/ssl/cert.pem") }],
      pattern: /^=== .*\/CN=(AAA Certificate Services|emSign ECC Root CA - G3)$/m,
      label,
      severity: "fail",
    },
    {
      kind: "pattern-absent",
      sources: [{ kind: "path", path: join(systemRoot, "etc/ca-certificates.conf") }],
      pattern: /^mozilla\/(Comodo_AAA_Services_root|emSign_ECC_Root_CA_-_G3)\.crt$/m,
      label,
      severity: "fail",
    },
  ] as const;
}

export const workstationPolicy = (systemRoot = "/") =>
  ({
    name: "workstation-security",
    summary: "workstation security audit summary",
    sections: [
      {
        title: "local config file modes",
        checks: [
          {
            kind: "file-mode",
            path: ".gitconfig.local",
            modes: [0o600],
            missing: "warn",
            mismatch: "fail",
          },
          {
            kind: "file-mode",
            path: ".ssh/config.local",
            modes: [0o600],
            missing: "warn",
            mismatch: "fail",
          },
          {
            kind: "file-mode",
            path: ".codex/config.toml",
            modes: [0o600],
            missing: "warn",
            mismatch: "fail",
          },
        ],
      },
      {
        title: "local secret scan",
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
              sshConfigs,
            ],
          },
          { kind: "npm-auth-boundary", path: ".npmrc" },
          {
            kind: "pattern-absent",
            sources: [homeDotfiles, sshConfigs, launchAgents],
            pattern: /op:\/\//,
            label: "1Password item references",
            severity: "warn",
          },
          {
            kind: "pattern-absent",
            sources: [{ kind: "path", path: ".docker/config.json" }],
            pattern: /"auth"\s*:/,
            label: "inline Docker auth material",
            severity: "fail",
          },
        ],
      },
      { title: "project env file privacy", checks: [projectEnvFiles] },
      { title: "TLS trust store", checks: compromisedRoots(systemRoot) },
      {
        title: "Git and GitHub identity",
        checks: [
          { kind: "git-identity", config: ".gitconfig", missing: "warn", identity: "combined" },
          { kind: "github-auth" },
        ],
      },
      {
        title: "SSH key file permissions",
        checks: [{ kind: "ssh-private-key-modes", path: ".ssh" }],
      },
      { title: "Codex log size", checks: [{ kind: "codex-log-size", path: ".codex" }] },
      {
        title: "Tailscale",
        checks: [
          {
            kind: "command-status",
            command: "tailscale",
            args: ["status", "--peers=false"],
            missing: "warn",
            failure: "warn",
            label: "tailscale status",
          },
        ],
      },
      {
        title: "application firewall",
        checks: [
          {
            kind: "command-status",
            command: "/usr/libexec/ApplicationFirewall/socketfilterfw",
            args: ["--getglobalstate"],
            missing: "warn",
            failure: "warn",
            label: "application firewall state",
            expect: {
              pattern: /State = [12]/,
              match: "application firewall is enabled",
              mismatch: "application firewall is disabled",
            },
          },
        ],
      },
    ],
  }) satisfies AuditPolicy;

function runWorkstation(format: AuditFormat): number {
  return runPolicy(workstationPolicy(), format).status;
}

function main(args: string[]): number {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "--json")) {
    process.stderr.write("Usage: audit/workstation.ts [--json]\n");
    return 2;
  }
  return runWorkstation(args[0] === "--json" ? "json" : "text");
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
