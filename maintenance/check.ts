#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { Effect, Schema } from "effect";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { legacyCheckouts, managedLockLocation } from "../agents/lock.ts";
import { readLayeredSkills, readSkillLock } from "../agents/skills/catalog.ts";
import { runMain } from "../lib/program.ts";

import { type ProfileConfig, readProfileModel, requireProfile } from "../profiles/model.ts";
import {
  collectMacOSUpdateInventory,
  defaultMacOSUpdateIO,
  type MacOSUpdateIO,
  type MacOSUpdateInventory,
} from "./darwin/macos-updates.ts";

import { probe, runProbe, runProcess, type Probe, type ProbeResult } from "./probes.ts";
import type { CommandRunner, RawCommandResult } from "./command.ts";
export type { CommandRunner, RawCommandResult } from "./command.ts";

type MaintenanceProbes = Record<string, ProbeResult> & {
  software_update?: ProbeResult<MacOSUpdateInventory>;
};

export type MaintenanceContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  hostname: string;
  ownsHomebrew: boolean;
  platform: NodeJS.Platform;
  profile: string;
  profileConfig: ProfileConfig;
  repoRoot: string;
  user: string;
  fresh: boolean;
  verify: boolean;
};

type BrewItem = {
  name: string;
  installed_versions: string[];
  current_version: string;
};

type BrewBacklog = {
  formulae: BrewItem[];
  casks: BrewItem[];
  record_lag?: BrewItem[];
  cask_verification?: Array<{
    name: string;
    status: "record_lag" | "pending" | "unknown";
    app_version?: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(contents: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(contents || "{}");
  if (!isRecord(parsed)) throw new Error(`${label} did not return a JSON object`);
  return parsed;
}

const NpmBacklog = Schema.Record(
  Schema.String,
  Schema.Struct({
    current: Schema.optionalKey(Schema.String),
    wanted: Schema.String,
    latest: Schema.String,
  }),
);

function parseNpmBacklog(contents: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(contents);
    if (Schema.is(NpmBacklog)(value)) return value;
  } catch {}
  throw new Error("npm returned an invalid update inventory");
}

function parseBrewItem(value: unknown): BrewItem {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !Array.isArray(value.installed_versions) ||
    !value.installed_versions.every((item) => typeof item === "string") ||
    typeof value.current_version !== "string"
  ) {
    throw new Error("Homebrew returned an invalid package record");
  }
  return {
    name: value.name,
    installed_versions: value.installed_versions,
    current_version: value.current_version,
  };
}

export function parseBrewBacklog(contents: string): BrewBacklog {
  const value = parseJsonObject(contents, "Homebrew");
  if (!Array.isArray(value.formulae) || !Array.isArray(value.casks)) {
    throw new Error("Homebrew backlog is missing formulae or casks");
  }
  return {
    formulae: value.formulae.map(parseBrewItem),
    casks: value.casks.map(parseBrewItem),
  };
}

const CaskInventory = Schema.Struct({
  casks: Schema.Array(
    Schema.Struct({
      token: Schema.String,
      full_token: Schema.optionalKey(Schema.String),
      bundle_short_version: Schema.optionalKey(Schema.NullOr(Schema.String)),
      bundle_version: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

function reconcileCaskVersions(backlog: BrewBacklog, inventory: unknown): BrewBacklog {
  const apps = Schema.is(CaskInventory)(inventory) ? inventory.casks : [];
  const record_lag: BrewItem[] = [];
  const casks: BrewItem[] = [];
  const cask_verification = backlog.casks.map((item) => {
    const app = apps.find((entry) => entry.token === item.name || entry.full_token === item.name);
    const short = app?.bundle_short_version;
    const build = app?.bundle_version;
    const app_version =
      short && build && item.current_version.includes(",")
        ? `${short},${build}`
        : short || build || undefined;
    const status =
      app_version === item.current_version ? "record_lag" : app_version ? "pending" : "unknown";
    (status === "record_lag" ? record_lag : casks).push(item);
    return { name: item.name, status, ...(app_version ? { app_version } : {}) } as const;
  });
  return { ...backlog, casks, record_lag, cask_verification };
}

function firstLine(result: RawCommandResult): string {
  return (
    `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseDisk(result: RawCommandResult) {
  const fields = result.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/) ?? [];
  if (fields.length < 6) throw new Error("df returned an unsupported shape");
  return {
    total_kb: Number(fields[1]),
    used_kb: Number(fields[2]),
    available_kb: Number(fields[3]),
    capacity: fields[4],
    mount: fields.at(-1),
  };
}

function parseTailscale(result: RawCommandResult) {
  const value = parseJsonObject(result.stdout, "Tailscale");
  const self = isRecord(value.Self) ? value.Self : {};
  const peers = isRecord(value.Peer) ? Object.values(value.Peer).filter(isRecord) : [];
  return {
    backend_state: typeof value.BackendState === "string" ? value.BackendState : "unknown",
    magic_dns_suffix: typeof value.MagicDNSSuffix === "string" ? value.MagicDNSSuffix : "",
    self_online: self.Online === true,
    peers_total: peers.length,
    peers_online: peers.filter((peer) => peer.Online === true).length,
  };
}

function parseGitStatus(result: RawCommandResult) {
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { branch: lines[0] ?? "", dirty_entries: Math.max(0, lines.length - 1) };
}

function parseWorktrees(result: RawCommandResult) {
  return {
    count: result.stdout.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length,
  };
}

function summaryLine(result: RawCommandResult) {
  return {
    passed: result.status === 0,
    summary: firstLine({ ...result, stdout: result.stdout.trim().split(/\r?\n/).at(-1) ?? "" }),
  };
}

function agentProbes(context: MaintenanceContext): Probe[] {
  const profile = context.profileConfig;
  const versions: Array<[string, string, string[]]> = [
    ["node", "node", ["--version"]],
    ["npm", "npm", ["--version"]],
    ["codex", "codex", ["--version"]],
    ["claude", "claude", ["--version"]],
  ];
  if (profile.capabilities.personal && profile.capabilities.workstation)
    versions.push(["grok", "grok", ["--version"]]);
  const env = {
    PATH: [
      join(context.home, ".local/bin"),
      join(context.home, ".local/share/mise/shims"),
      context.env.PATH,
    ]
      .filter(Boolean)
      .join(":"),
  };
  return versions.map(([id, command, args]) =>
    probe(`version_${id}`, command, args, firstLine, { env }),
  );
}

function checkoutPath(context: MaintenanceContext): string | undefined {
  return context.repoRoot.startsWith(`${context.home}/`) &&
    existsSync(join(context.repoRoot, ".git"))
    ? context.repoRoot
    : undefined;
}

function skillFacts(context: MaintenanceContext) {
  if (context.profileConfig.agentLayers.length === 0)
    return { managed: false, selected: 0, locked: 0, installed: 0 };
  const { skills: selected } = readLayeredSkills(
    context.repoRoot,
    context.profile,
    context.profileConfig.agentLayers,
  );
  const stateLock = managedLockLocation({ ...process.env, HOME: context.home }, "skills");
  const lockPath = [
    stateLock,
    ...legacyCheckouts(context.repoRoot).map((checkout) =>
      join(checkout, "agents/skills.lock.json"),
    ),
  ].find((candidate) => existsSync(candidate));
  const locked = (lockPath && readSkillLock(lockPath)?.length) ?? 0;
  const installedRoot = join(context.home, ".agents/skills");
  const installed = existsSync(installedRoot)
    ? readdirSync(installedRoot, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && existsSync(join(installedRoot, entry.name, "SKILL.md")),
      ).length
    : 0;
  return { managed: true, selected: selected.length, locked, installed };
}

function buildProbes(context: MaintenanceContext): Probe[] {
  const hostOwner = context.ownsHomebrew || context.profileConfig.capabilities.workstation;
  const probes: Probe[] = [
    probe(
      "mise_outdated",
      "mise",
      ["outdated", "--json"],
      (result) => parseJsonObject(result.stdout, "mise"),
      { allowedStatuses: [0, 1] },
    ),
    probe(
      "npm_outdated",
      "npm",
      ["outdated", "-g", "--json"],
      (result) => parseNpmBacklog(result.stdout),
      { allowedStatuses: [0, 1] },
    ),
    ...agentProbes(context),
  ];

  if (hostOwner) {
    probes.push(
      probe(
        "system",
        context.platform === "darwin" ? "sw_vers" : "uname",
        context.platform === "darwin" ? [] : ["-sr"],
        (result) => result.stdout.trim(),
      ),
      probe("disk", "df", ["-Pk", "/"], parseDisk),
      probe("uptime", "uptime", [], (result) => result.stdout.trim()),
      probe("tailscale_status", "tailscale", ["status", "--json"], parseTailscale),
      probe("tailscale_version", "tailscale", ["version"], firstLine),
    );
  }
  if (
    context.profileConfig.capabilities.personal &&
    context.profileConfig.capabilities.workstation
  ) {
    probes.push(
      probe(
        "mas_outdated",
        "mas",
        ["outdated"],
        (result) =>
          result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        {
          env: { ...context.env, MAS_NO_AUTO_INDEX: "1" },
          required: false,
        },
      ),
    );
  }
  if (context.profileConfig.capabilities.devbox && context.platform === "darwin") {
    probes.push(
      probe(
        "devbox_services",
        process.execPath,
        [join(context.repoRoot, "verify/darwin/devbox-services.ts")],
        summaryLine,
        { timeoutMs: 30_000 },
      ),
    );
  }
  if (context.verify) {
    probes.push(
      probe(
        "bootstrap",
        process.execPath,
        [join(context.repoRoot, "verify/bootstrap.ts"), "--profile", context.profile],
        summaryLine,
        { timeoutMs: 60_000 },
      ),
    );
  }

  const checkout = checkoutPath(context);
  if (checkout) {
    probes.push(
      probe("dotfiles_status", "git", ["status", "--short", "--branch"], parseGitStatus, {
        env: context.env,
      }),
      probe("dotfiles_worktrees", "git", ["worktree", "list", "--porcelain"], parseWorktrees, {
        env: context.env,
      }),
    );
    for (const item of probes.slice(-2)) item.env = { ...item.env, DOTFILES_CHECKOUT: checkout };
  }
  return probes;
}

async function runBrewBacklogProbe(
  context: MaintenanceContext,
  runner: CommandRunner,
): Promise<ProbeResult> {
  const started = performance.now();
  const refresh = await runProbe(
    probe("brew_update", "brew", ["update"], () => null),
    context,
    runner,
  );
  if (refresh.status !== "ok") {
    return {
      status: refresh.status,
      required: true,
      duration_ms: Math.round(performance.now() - started),
      error: `brew update failed: ${refresh.error ?? refresh.status}`,
    };
  }

  const backlog = await runProbe(
    probe("brew_outdated_greedy", "brew", ["outdated", "--greedy", "--json=v2"], (result) =>
      parseBrewBacklog(result.stdout),
    ),
    context,
    runner,
  );
  if (backlog.status === "ok" && context.platform === "darwin") {
    const value = parseBrewBacklog(JSON.stringify(backlog.value));
    if (value.casks.length > 0) {
      const inventory = await runProbe(
        probe(
          "brew_cask_apps",
          "brew",
          ["info", "--json=v2", "--cask", ...value.casks.map((item) => item.name)],
          (result) => Schema.decodeUnknownSync(CaskInventory)(JSON.parse(result.stdout)),
        ),
        context,
        runner,
      );
      backlog.value = reconcileCaskVersions(
        value,
        inventory.status === "ok" ? inventory.value : undefined,
      );
    }
  }
  return { ...backlog, duration_ms: Math.round(performance.now() - started) };
}

function backlogCount(probes: Record<string, ProbeResult>): number {
  let count = 0;
  const brew = probes.brew_outdated_greedy?.value;
  if (isRecord(brew)) {
    count += Array.isArray(brew.formulae) ? brew.formulae.length : 0;
    count += Array.isArray(brew.casks) ? brew.casks.length : 0;
  }
  for (const id of ["mise_outdated", "npm_outdated"]) {
    const value = probes[id]?.value;
    if (isRecord(value)) count += Object.keys(value).length;
  }
  const mas = probes.mas_outdated?.value;
  if (Array.isArray(mas)) count += mas.length;
  return count;
}

export async function collectMaintenanceSnapshot(
  context: MaintenanceContext,
  runner: CommandRunner = runProcess,
  macosUpdateIO: MacOSUpdateIO = defaultMacOSUpdateIO,
  signal?: AbortSignal,
) {
  const hostOwner = context.ownsHomebrew || context.profileConfig.capabilities.workstation;
  const inventory =
    hostOwner && context.platform === "darwin"
      ? collectMacOSUpdateInventory(
          {
            cwd: context.cwd,
            env: context.env,
            fresh: context.fresh || context.verify,
            home: context.home,
          },
          runner,
          macosUpdateIO,
          signal,
        )
      : undefined;
  const [entries, macosUpdates] = await Promise.all([
    Promise.all([
      ...buildProbes(context).map(
        async (spec) => [spec.id, await runProbe(spec, context, runner)] as const,
      ),
      ...(context.ownsHomebrew
        ? [
            runBrewBacklogProbe(context, runner).then(
              (result) => ["brew_outdated_greedy", result] as const,
            ),
          ]
        : []),
    ]),
    inventory,
  ]);
  const probes: MaintenanceProbes = {};
  for (const [id, result] of entries) probes[id] = result;
  if (macosUpdates) {
    probes.software_update = {
      status: macosUpdates.applicability.status === "unknown" ? "failed" : "ok",
      required: true,
      duration_ms: macosUpdates.duration_ms,
      value: macosUpdates,
      ...(macosUpdates.applicability.status === "unknown"
        ? { error: "macOS update applicability could not be established" }
        : {}),
    };
  }
  const backlog_count = backlogCount(probes);
  const required_failures = Object.values(probes).filter(
    (result) => result.required && result.status !== "ok",
  ).length;
  const software = macosUpdates as MacOSUpdateInventory | undefined;
  const software_update_status = software?.applicability.status ?? "not_applicable";
  const software_update_available = software?.applicability.status === "updates_available";
  return {
    schema_version: 2,
    collected_at: new Date().toISOString(),
    identity: { host: context.hostname, user: context.user, profile: context.profile },
    capabilities: context.profileConfig.capabilities,
    checkout: checkoutPath(context) ?? null,
    skills: skillFacts(context),
    summary: {
      status:
        required_failures > 0
          ? "incomplete"
          : backlog_count > 0 || software_update_available
            ? "attention"
            : "clean",
      backlog_count,
      required_failures,
      software_update_status,
      software_update_available,
    },
    probes,
  };
}

function ownsHomebrew(env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync("brew", ["--prefix"], { encoding: "utf8", env });
  if (result.status !== 0) return false;
  try {
    return statSync(result.stdout.trim()).uid === (process.getuid?.() ?? -1);
  } catch {
    return false;
  }
}

export const collectMaintenanceSnapshotEffect = Effect.fn("collectMaintenanceSnapshot")(function* (
  context: MaintenanceContext,
  macosUpdateIO: MacOSUpdateIO = defaultMacOSUpdateIO,
) {
  const active = new Set<Promise<RawCommandResult>>();
  let collection: Promise<unknown> | undefined;
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.promise(async () => {
        controller.abort();
        await Promise.allSettled([...active, ...(collection ? [collection] : [])]);
      }),
  );
  const runner: CommandRunner = (command, args, options) => {
    const pending = runProcess(command, args, { ...options, signal: controller.signal });
    active.add(pending);
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    );
    return pending;
  };
  return yield* Effect.tryPromise({
    try: () => {
      const pending = collectMaintenanceSnapshot(context, runner, macosUpdateIO, controller.signal);
      collection = pending;
      return pending;
    },
    catch: (error) => error,
  });
}, Effect.scoped);

const main = Effect.fn("maintenanceCheck")(function* () {
  const args = process.argv.slice(2);
  if (
    args.some((argument) => argument !== "--fresh" && argument !== "--verify") ||
    new Set(args).size !== args.length
  ) {
    process.stderr.write("Usage: maintenance/check.ts [--fresh] [--verify]\n");
    return 2;
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = process.env.HOME || homedir();
  const profile = yield* Effect.try(() =>
    readFileSync(join(home, ".config/dotfiles/profile"), "utf8").trim(),
  );
  const model = yield* Effect.try(() =>
    readProfileModel(join(repoRoot, "chezmoi/.chezmoidata/profiles.json")),
  );
  const profileConfig = yield* Effect.try(() => requireProfile(model, profile));
  const snapshot = yield* collectMaintenanceSnapshotEffect({
    cwd: repoRoot,
    env: process.env,
    home,
    hostname: hostname(),
    ownsHomebrew: ownsHomebrew(process.env),
    platform: process.platform,
    profile,
    profileConfig,
    repoRoot,
    user: process.env.USER || "unknown",
    fresh: args.includes("--fresh"),
    verify: args.includes("--verify"),
  });
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  return 0;
});

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMain(
    main().pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          process.exitCode = status;
        }),
      ),
      Effect.asVoid,
    ),
  );
}
