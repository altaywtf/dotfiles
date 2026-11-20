#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { Effect, Option, Predicate, Schema } from "effect";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { managedLockLocation } from "../agents/lock.ts";
import { readLayeredSkills, readSkillLock } from "../agents/skills/catalog.ts";
import { runMain } from "../lib/program.ts";

import { readProfileModel, requireProfile } from "../profiles/model.ts";
import type { ProfileConfig } from "../profiles/model.ts";
import { collectMacOSUpdateInventory, defaultMacOSUpdateIO } from "./darwin/macos-updates.ts";
import type { MacOSUpdateIO, MacOSUpdateInventory } from "./darwin/macos-updates.ts";

import { probe, runProbe, runProcess } from "./probes.ts";
import type { Probe, ProbeResult } from "./probes.ts";
import { dropInvalid } from "./schema.ts";
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

const BrewItem = Schema.Struct({
  name: Schema.String,
  installed_versions: Schema.Array(Schema.String),
  current_version: Schema.String,
});
type BrewItem = typeof BrewItem.Type;

const BrewOutdated = Schema.Struct({
  formulae: Schema.Array(BrewItem),
  casks: Schema.Array(BrewItem),
});

type BrewBacklog = typeof BrewOutdated.Type & {
  record_lag?: BrewItem[];
  cask_verification?: Array<{
    name: string;
    status: "record_lag" | "pending" | "unknown";
    app_version?: string;
  }>;
};

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

function decodeJsonOutput<S extends Schema.Decoder<unknown>>(
  schema: S,
  contents: string,
  message: string,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(contents);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
}

const NpmBacklog = Schema.Record(
  Schema.String,
  Schema.Struct({
    current: Schema.optionalKey(Schema.String),
    wanted: Schema.String,
    latest: Schema.String,
  }),
);

const MiseConfig = Schema.Struct({
  tools: Schema.Record(
    Schema.String,
    Schema.Union([Schema.NonEmptyString, Schema.Struct({ version: Schema.NonEmptyString })]),
  ),
});
const MiseInstallInventory = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.Struct({
      version: Schema.NonEmptyString,
      requested_version: Schema.NonEmptyString,
      installed: Schema.Boolean,
    }),
  ),
);

function misePins(path: string): Record<string, string> {
  try {
    const config = Schema.decodeUnknownSync(MiseConfig)(parseToml(readFileSync(path, "utf8")));
    return Object.fromEntries(
      Object.entries(config.tools).map(([tool, pin]) => [
        tool,
        Predicate.isString(pin) ? pin : pin.version,
      ]),
    );
  } catch (error) {
    throw new Error(`cannot inspect mise pins in ${path}`, { cause: error });
  }
}

function miseConvergence(context: MaintenanceContext, result: RawCommandResult) {
  const templates = join(context.repoRoot, "chezmoi/.chezmoitemplates");
  const declared = {
    ...misePins(join(templates, "mise.toml")),
    ...misePins(join(templates, context.platform, "mise.toml")),
  };
  const configured = misePins(
    context.env.MISE_GLOBAL_CONFIG_FILE ||
      join(context.env.XDG_CONFIG_HOME || join(context.home, ".config"), "mise/config.toml"),
  );
  let inventory: typeof MiseInstallInventory.Type;
  try {
    inventory = Schema.decodeUnknownSync(Schema.fromJsonString(MiseInstallInventory))(
      result.stdout,
    );
  } catch (error) {
    throw new Error("mise returned an invalid installed pin inventory", { cause: error });
  }
  const pending: Record<
    string,
    { declared: string; configured: string | null; current: string | null; installed: boolean }
  > = {};
  for (const [tool, pin] of Object.entries(declared)) {
    const selection = inventory[tool]?.find(
      (entry) => entry.requested_version === configured[tool],
    );
    if (configured[tool] && !selection)
      throw new Error(`mise did not report the configured installation of ${tool}`);
    if (configured[tool] !== pin || !selection?.installed) {
      pending[tool] = {
        declared: pin,
        configured: configured[tool] ?? null,
        current: selection?.version ?? null,
        installed: selection?.installed ?? false,
      };
    }
  }
  return pending;
}

export function parseBrewBacklog(contents: string): BrewBacklog {
  return decodeJsonOutput(
    BrewOutdated,
    contents,
    "Homebrew returned an invalid outdated inventory",
  );
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

const TailscaleNode = Schema.Struct({ Online: Schema.optionalKey(dropInvalid(Schema.Boolean)) });

const TailscaleStatus = Schema.Struct({
  BackendState: Schema.optionalKey(dropInvalid(Schema.String)),
  MagicDNSSuffix: Schema.optionalKey(dropInvalid(Schema.String)),
  Self: Schema.optionalKey(dropInvalid(TailscaleNode)),
  Peer: Schema.optionalKey(dropInvalid(Schema.Record(Schema.String, dropInvalid(TailscaleNode)))),
});

function parseTailscale(result: RawCommandResult) {
  const value = decodeJsonOutput(
    TailscaleStatus,
    result.stdout || "{}",
    "Tailscale did not return a JSON object",
  );
  const peers = Object.values(value.Peer ?? {});
  return {
    backend_state: value.BackendState ?? "unknown",
    magic_dns_suffix: value.MagicDNSSuffix ?? "",
    self_online: value.Self?.Online === true,
    peers_total: peers.length,
    peers_online: peers.filter((peer) => peer.Online === true).length,
  };
}

const CacheLocator = Schema.Struct({
  results: Schema.Struct({
    system: Schema.Struct({
      "refreshed servers": Schema.Struct({
        "shared caching": Schema.Array(
          Schema.Struct({ hostport: Schema.String, healthy: Schema.Boolean }),
        ),
      }),
    }),
  }),
});

function parseContentCaches(result: RawCommandResult) {
  let locator: typeof CacheLocator.Type;
  try {
    locator = Schema.decodeUnknownSync(Schema.fromJsonString(CacheLocator))(result.stdout);
  } catch (error) {
    throw new Error("AssetCacheLocatorUtil returned an invalid cache inventory", { cause: error });
  }
  return locator.results.system["refreshed servers"]["shared caching"].map(
    ({ hostport, healthy }) => ({ hostport, healthy }),
  );
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
  const versions: Array<[string, string, string[]]> = [
    ["node", "node", ["--version"]],
    ["npm", "npm", ["--version"]],
    ["codex", "codex", ["--version"]],
    ["claude", "claude", ["--version"]],
  ];
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
  const lockPath = managedLockLocation({ ...process.env, HOME: context.home }, "skills");
  const locked = readSkillLock(lockPath)?.length ?? 0;
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
      "mise_convergence",
      "mise",
      ["ls", "--json", "--current"],
      (result) => miseConvergence(context, result),
      { env: { DOTFILES_CHECKOUT: context.home } },
    ),
    probe(
      "mise_outdated",
      "mise",
      ["outdated", "--json"],
      (result) =>
        decodeJsonOutput(JsonObject, result.stdout || "{}", "mise did not return a JSON object"),
      { allowedStatuses: [0, 1] },
    ),
    probe(
      "npm_outdated",
      "npm",
      ["outdated", "-g", "--json"],
      (result) =>
        decodeJsonOutput(NpmBacklog, result.stdout, "npm returned an invalid update inventory"),
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
    );
    if (context.platform === "darwin") {
      probes.push(
        probe("content_cache", "AssetCacheLocatorUtil", ["-j"], parseContentCaches, {
          required: false,
        }),
      );
    }
    // Only the devbox and personal Brewfiles install Tailscale.
    if (context.profileConfig.capabilities.devbox || context.profileConfig.capabilities.personal) {
      probes.push(
        probe("tailscale_status", "tailscale", ["status", "--json"], parseTailscale),
        probe("tailscale_version", "tailscale", ["version"], firstLine),
      );
    }
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
    probe("brew_update", "brew", ["update"], () => null, { timeoutMs: 120_000 }),
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
    const value = Schema.decodeUnknownSync(BrewOutdated)(backlog.value);
    if (value.casks.length > 0) {
      const inventory = await runProbe(
        probe(
          "brew_cask_apps",
          "brew",
          ["info", "--json=v2", "--cask", ...value.casks.map((item) => item.name)],
          (result) => Schema.decodeUnknownSync(Schema.fromJsonString(CaskInventory))(result.stdout),
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

const PendingKeys = Schema.Record(Schema.String, Schema.Unknown);
const PendingList = Schema.Array(Schema.Unknown);

function backlogCount(probes: Record<string, ProbeResult>): number {
  let count = 0;
  const brew = Schema.decodeUnknownOption(BrewOutdated)(probes.brew_outdated_greedy?.value);
  if (Option.isSome(brew)) count += brew.value.formulae.length + brew.value.casks.length;
  const misePending = new Set<string>();
  for (const id of ["mise_outdated", "mise_convergence"]) {
    const value = Schema.decodeUnknownOption(PendingKeys)(probes[id]?.value);
    if (Option.isSome(value)) for (const tool of Object.keys(value.value)) misePending.add(tool);
  }
  count += misePending.size;
  const npm = Schema.decodeUnknownOption(PendingKeys)(probes.npm_outdated?.value);
  if (Option.isSome(npm)) count += Object.keys(npm.value).length;
  const mas = Schema.decodeUnknownOption(PendingList)(probes.mas_outdated?.value);
  if (Option.isSome(mas)) count += mas.value.length;
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
  const software_update_status = macosUpdates?.applicability.status ?? "not_applicable";
  const software_update_available = macosUpdates?.applicability.status === "updates_available";
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
  const repoRoot = resolve(import.meta.dirname, "..");
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
