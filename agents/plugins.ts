#!/usr/bin/env node

import { sanitizeDiagnostic } from "../lib/diagnostics.ts";

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Effect, Schema } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import type { AgentLayer } from "../profiles/model.ts";
import { decodeOr, decodeOrThrow, readJsonFile } from "./decode.ts";
import {
  composeLayers,
  HARNESS_INFO,
  HARNESSES,
  LockedHarnesses,
  ManifestHarnesses,
  parseSyncArgs,
  reportSyncFailures,
  SafeName,
  safeName,
} from "./harness.ts";
import type { Harness, SyncFailure } from "./harness.ts";
import { readLocalOverlay } from "./local.ts";
import { planOwnership } from "./ownership.ts";
import {
  guardOverlay,
  managedLockLocation,
  readLockFile,
  readOverlayOwnership,
  withManagedLock,
  writeLockFile,
} from "./lock.ts";
import type { OverlayOwnership } from "./lock.ts";
import { createRuntime, errorMessage, resolveProfileName, writeLine } from "./runtime.ts";
import type { Runtime } from "./runtime.ts";

export { HARNESSES } from "./harness.ts";

const GITHUB_MARKETPLACE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCP_MARKETPLACE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

function isMarketplaceSource(source: string): boolean {
  if (GITHUB_MARKETPLACE.test(source) || SCP_MARKETPLACE.test(source)) {
    return true;
  }
  if (isAbsolute(source)) {
    return true;
  }
  if (!URL.canParse(source)) {
    return false;
  }
  const url = new URL(source);
  return (
    (url.protocol === "https:" && url.username === "" && url.password === "") ||
    (url.protocol === "ssh:" && url.password === "")
  );
}

const MarketplaceSource = Schema.String.check(Schema.makeFilter(isMarketplaceSource));

const MarketplaceId = safeName("marketplaceId must be a safe name");

const PluginIdentity = Schema.Struct({ marketplace: MarketplaceSource, name: SafeName });

const PluginEntry = Schema.Struct({
  marketplace: MarketplaceSource,
  name: SafeName,
  marketplaceId: Schema.optionalKey(MarketplaceId),
  harnesses: ManifestHarnesses,
});

const LockedPluginIdentity = Schema.Struct({
  marketplace: MarketplaceSource,
  marketplaceId: SafeName,
  name: SafeName,
  harnesses: Schema.Unknown,
});

const Plugin = Schema.Struct({
  marketplace: MarketplaceSource,
  marketplaceId: SafeName,
  name: SafeName,
  harnesses: LockedHarnesses,
});
export type Plugin = typeof Plugin.Type;

const PluginManifest = Schema.Struct({ plugins: Schema.Unknown });

const PluginLockDocument = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(Schema.Unknown),
});

type PlannedCommand = {
  command: string;
  args: ReadonlyArray<string>;
  marketplace?: string;
  plugin?: string;
  refresh?: boolean;
};

type PluginFailure = SyncFailure;

type HarnessSpec = {
  binary: string;
  label: string;
  marketplaceArgs?: (plugin: Plugin) => Array<string>;
  upgradeMarketplaceArgs?: (plugin: Plugin) => Array<string>;
  installArgs?: (plugin: Plugin) => Array<string>;
  updateArgs?: (plugin: Plugin) => Array<string>;
};

const HARNESS_SPECS: Record<Harness, HarnessSpec> = {
  claude: {
    ...HARNESS_INFO.claude,
    marketplaceArgs: (plugin) => ["plugin", "marketplace", "add", plugin.marketplace],
    installArgs: (plugin) => ["plugin", "install", pluginRef(plugin)],
    updateArgs: (plugin) => ["plugin", "update", pluginRef(plugin), "-y"],
  },
  codex: {
    ...HARNESS_INFO.codex,
    marketplaceArgs: (plugin) => ["plugin", "marketplace", "add", plugin.marketplace],
    upgradeMarketplaceArgs: (plugin) =>
      isAbsolute(plugin.marketplace)
        ? []
        : ["plugin", "marketplace", "upgrade", plugin.marketplaceId],
    installArgs: (plugin) => ["plugin", "add", pluginRef(plugin)],
  },
};

export function pluginRef(plugin: Plugin): string {
  return `${plugin.name}@${plugin.marketplaceId}`;
}

function readPlugin(value: unknown, context: string): Plugin {
  const { name } = decodeOr(
    PluginIdentity,
    value,
    `${context}: expected a marketplace (owner/repo, HTTPS or SSH Git URL without credentials, or absolute path) and a safe plugin name`,
  );
  const entry = decodeOrThrow(PluginEntry, value, (detail) => `${context}: ${name} ${detail}`);

  const marketplaceId =
    entry.marketplaceId ??
    (GITHUB_MARKETPLACE.test(entry.marketplace) ? entry.marketplace.split("/")[1] : undefined);
  if (marketplaceId === undefined) {
    throw new Error(
      `${context}: ${name} needs a marketplaceId because its marketplace is not owner/repo`,
    );
  }
  return {
    marketplace: entry.marketplace,
    marketplaceId: decodeOrThrow(
      MarketplaceId,
      marketplaceId,
      (detail) => `${context}: ${name} ${detail}`,
    ),
    name,
    harnesses: entry.harnesses,
  };
}

function parsePlugins(value: unknown, context: string): Array<Plugin> {
  const entries = decodeOr(
    Schema.Array(Schema.Unknown),
    value,
    `${context}: expected a plugins array`,
  );
  const plugins = entries.map((plugin) => readPlugin(plugin, context));
  const refs = new Set<string>();
  for (const plugin of plugins) {
    const ref = pluginRef(plugin);
    if (refs.has(ref)) {
      throw new Error(`${context}: ${ref} is defined more than once`);
    }
    refs.add(ref);
  }
  return plugins;
}

export function readPlugins(manifestPath: string): Array<Plugin> {
  const context = `Invalid plugins manifest at ${manifestPath}`;
  const { plugins } = decodeOr(
    PluginManifest,
    readJsonFile(manifestPath, context),
    `${context}: expected a plugins array`,
  );
  return parsePlugins(plugins, context);
}

export type PluginLayer = AgentLayer | "local";

export function readLayeredPlugins(
  repoDir: string,
  profile: string,
  layers: ReadonlyArray<AgentLayer>,
): {
  layers: ReadonlyArray<PluginLayer>;
  plugins: Array<Plugin>;
  localPath?: string;
  localNames?: Array<string>;
} {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent plugins`);
  }

  const manifests = new Map<PluginLayer, Array<Plugin>>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    manifests.set(layer, readPlugins(join(repoDir, "agents", "plugins", `${layer}.json`)));
  }

  const selected: Array<PluginLayer> = [...layers];
  const local = readLocalOverlay(repoDir);
  if (local?.document.plugins !== undefined) {
    manifests.set(
      "local",
      parsePlugins(local.document.plugins, `Invalid local agent overlay at ${local.path}`),
    );
    selected.push("local");
  }

  const plugins = composeLayers(
    selected,
    manifests,
    pluginRef,
    (ref) => `Invalid layered plugins: ${ref} is defined more than once`,
  );
  const marketplaceIds = new Map<string, string>();
  for (const plugin of plugins) {
    const known = marketplaceIds.get(plugin.marketplace);
    if (known !== undefined && known !== plugin.marketplaceId) {
      throw new Error(
        `Invalid layered plugins: ${plugin.marketplace} is registered as both ${known} and ${plugin.marketplaceId}`,
      );
    }
    marketplaceIds.set(plugin.marketplace, plugin.marketplaceId);
  }
  return selected.includes("local") && local
    ? {
        layers: selected,
        plugins,
        localPath: local.path,
        localNames: (manifests.get("local") ?? []).map(pluginRef),
      }
    : { layers: selected, plugins };
}

type PluginLock = {
  version: 1;
  plugins: Array<Plugin>;
  overlays?: OverlayOwnership;
};

function readLockedPlugin(value: unknown, lockPath: string): Plugin {
  const label = `Invalid managed plugins lock at ${lockPath}`;
  const { name } = decodeOr(
    LockedPluginIdentity,
    value,
    `${label}: expected explicit marketplace, marketplaceId, name, and harnesses`,
  );
  return decodeOrThrow(Plugin, value, (detail) => `${label}: ${name} ${detail}`);
}

function readPluginLock(lockPath: string): Array<Plugin> | undefined {
  const parsed = readLockFile(lockPath, "plugins");
  if (parsed === undefined) {
    return undefined;
  }

  const lock = decodeOr(
    PluginLockDocument,
    parsed,
    `Invalid managed plugins lock at ${lockPath}: expected version 1 and a plugins array`,
  );
  const plugins = lock.plugins.map((plugin) => readLockedPlugin(plugin, lockPath));
  const refs = plugins.map(pluginRef);
  if (new Set(refs).size !== refs.length) {
    throw new Error(`Invalid managed plugins lock at ${lockPath}: plugin refs must be unique`);
  }
  return plugins;
}

function writePluginLock(
  lockPath: string,
  plugins: ReadonlyArray<Plugin>,
  overlays?: OverlayOwnership,
): void {
  const lock: PluginLock = { version: 1, plugins: [...plugins], overlays };
  writeLockFile(lockPath, lock);
}

function withKept(next: ReadonlyArray<Plugin>, kept: ReadonlyArray<Plugin>): Array<Plugin> {
  const merged = new Map(next.map((plugin) => [pluginRef(plugin), plugin]));
  for (const plugin of kept) {
    const current = merged.get(pluginRef(plugin));
    merged.set(pluginRef(plugin), {
      ...plugin,
      harnesses: HARNESSES.filter(
        (harness) => plugin.harnesses.includes(harness) || current?.harnesses.includes(harness),
      ),
    });
  }
  return [...merged.values()];
}

function uninstallArgs(harness: Harness, plugin: Plugin): Array<string> {
  switch (harness) {
    case "claude":
      return ["plugin", "uninstall", "-y", pluginRef(plugin)];
    case "codex":
      return ["plugin", "remove", pluginRef(plugin)];
  }
}

function alreadyUninstalled(harness: Harness, output: string): boolean {
  return (
    harness === "claude" &&
    /not found in installed plugins|is not installed in user scope/.test(output)
  );
}

function removeStalePlugins(
  runtime: Runtime,
  stale: ReadonlyArray<Plugin>,
  available: ReadonlyArray<Harness>,
  failures: Array<PluginFailure>,
): Array<Plugin> {
  const leftover: Array<Plugin> = [];

  for (const plugin of stale) {
    const leftoverHarnesses: Array<Harness> = [];
    for (const harness of plugin.harnesses) {
      const spec = HARNESS_SPECS[harness];
      if (!runtime.commandExists(spec.binary)) {
        leftoverHarnesses.push(harness);
        writeLine(
          runtime.stdout,
          `Skipping ${spec.label} plugin removal: '${spec.binary}' is not installed`,
        );
        continue;
      }
      if (!available.includes(harness)) {
        leftoverHarnesses.push(harness);
        continue;
      }

      const args = uninstallArgs(harness, plugin);

      writeLine(
        runtime.stdout,
        `Removing stale managed plugin: ${pluginRef(plugin)} from ${spec.label}`,
      );
      const result = runtime.run(spec.binary, args, { stdout: "capture", stderr: "capture" });
      if (
        result.status !== 0 &&
        alreadyUninstalled(harness, `${result.stdout}\n${result.stderr}`)
      ) {
        writeLine(runtime.stdout, `${spec.label}: ${pluginRef(plugin)} is already uninstalled`);
      } else if (result.status !== 0) {
        leftoverHarnesses.push(harness);
        failures.push({
          diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
          summary: `${spec.label}: ${args.join(" ")} (exit ${result.status})`,
        });
      }
    }

    if (leftoverHarnesses.length > 0) {
      leftover.push({ ...plugin, harnesses: leftoverHarnesses });
    }
  }

  return leftover;
}

function planHarness(
  harness: Harness,
  plugins: ReadonlyArray<Plugin>,
  options: { update?: boolean } = {},
): Array<PlannedCommand> {
  const spec = HARNESS_SPECS[harness];
  const selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));
  const planned: Array<PlannedCommand> = [];
  const marketplaces = new Set<string>();

  const marketplaceArgs = spec.marketplaceArgs;
  if (marketplaceArgs !== undefined) {
    for (const plugin of selected) {
      if (marketplaces.has(plugin.marketplace)) {
        continue;
      }
      marketplaces.add(plugin.marketplace);
      planned.push({
        command: spec.binary,
        args: marketplaceArgs(plugin),
        marketplace: plugin.marketplace,
      });
      const upgradeArgs = spec.upgradeMarketplaceArgs?.(plugin) ?? [];
      if (options.update === true && upgradeArgs.length > 0) {
        planned.push({
          command: spec.binary,
          args: upgradeArgs,
          marketplace: plugin.marketplace,
          refresh: true,
        });
      }
    }
  }

  const installArgs = spec.installArgs;
  if (installArgs === undefined) {
    return planned;
  }

  for (const plugin of selected) {
    planned.push({
      command: spec.binary,
      args: installArgs(plugin),
      marketplace: plugin.marketplace,
      plugin: pluginRef(plugin),
    });
  }

  if (options.update === true && spec.updateArgs !== undefined) {
    for (const plugin of selected) {
      planned.push({
        command: spec.binary,
        args: spec.updateArgs(plugin),
        marketplace: plugin.marketplace,
        plugin: pluginRef(plugin),
        refresh: true,
      });
    }
  }

  return planned;
}

function applyHarness(
  runtime: Runtime,
  harness: Harness,
  plugins: ReadonlyArray<Plugin>,
  available: ReadonlyArray<Harness>,
  failures: Array<PluginFailure>,
  update: boolean,
): void {
  const spec = HARNESS_SPECS[harness];
  const selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));

  if (!runtime.commandExists(spec.binary)) {
    writeLine(runtime.stdout, `Skipping ${spec.label} plugins: '${spec.binary}' is not installed`);
    return;
  }
  if (!available.includes(harness)) {
    return;
  }

  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${spec.label} plugins are selected for this profile`);
    return;
  }

  const blockedMarketplaces = new Set<string>();
  const blockedPlugins = new Set<string>();
  for (const planned of planHarness(harness, plugins, { update })) {
    if (
      planned.refresh === true &&
      ((planned.marketplace !== undefined && blockedMarketplaces.has(planned.marketplace)) ||
        (planned.plugin !== undefined && blockedPlugins.has(planned.plugin)))
    ) {
      continue;
    }
    writeLine(runtime.stdout, `${spec.label}: ${planned.command} ${planned.args.join(" ")}`);
    const result = runtime.run(planned.command, planned.args, {
      stdout: "capture",
      stderr: "capture",
    });
    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${spec.label}: ${planned.args.join(" ")} (exit ${result.status})`,
      });
      if (planned.plugin !== undefined) {
        blockedPlugins.add(planned.plugin);
      } else if (planned.marketplace !== undefined) {
        blockedMarketplaces.add(planned.marketplace);
      }
    }
  }
}

function piPluginConfig(plugins: ReadonlyArray<Plugin>) {
  const claudePlugins = plugins.filter((plugin) => plugin.harnesses.includes("claude"));
  return {
    autoapply: true,
    marketplaces: Object.fromEntries(
      claudePlugins.map((plugin) => [plugin.marketplaceId, { source: plugin.marketplace }]),
    ),
    plugins: Object.fromEntries(claudePlugins.map((plugin) => [pluginRef(plugin), {}])),
  };
}

function writePiPlugins(runtime: Runtime, plugins: ReadonlyArray<Plugin>): void {
  if (!runtime.commandExists("pi")) {
    writeLine(runtime.stdout, "Skipping Pi plugins: 'pi' is not installed");
    return;
  }
  if (!runtime.env.HOME) {
    throw new Error("HOME is required to locate the Pi plugin config");
  }
  const configPath = join(runtime.env.HOME, ".pi/agent/claude-plugins.json");
  const config = piPluginConfig(plugins);
  const next = `${JSON.stringify(config, null, 2)}\n`;
  let current: string | undefined;
  try {
    current = readFileSync(configPath, "utf8");
  } catch {
    current = undefined;
  }
  if (current === next) {
    return;
  }
  writeLockFile(configPath, config);
  writeLine(runtime.stdout, `Pi: wrote ${configPath}`);
}

type PluginOptions = {
  profile?: string;
  update: boolean;
};

const USAGE = "Usage: ./agents/plugins.ts [--profile PROFILE] [--update]";

function apply(runtime: Runtime, options: PluginOptions): number {
  const scriptDir = import.meta.dirname;
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const layered = readLayeredPlugins(repoDir, profileName, profile.agentLayers);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `Plugin layers: ${layered.layers.join(", ")}`);
  if (layered.localPath) {
    writeLine(runtime.stdout, `Local overlay: ${layered.localPath}`);
  }
  const available = HARNESSES.filter((harness) =>
    runtime.commandExists(HARNESS_INFO[harness].binary),
  );
  const plugins = layered.plugins;

  const pluginLockPath = managedLockLocation(runtime.env, "plugins");
  const previouslyManaged = readPluginLock(pluginLockPath);
  const overlay = guardOverlay(readOverlayOwnership(pluginLockPath), repoDir, layered.localNames);
  const keptOverlay = (previouslyManaged ?? []).filter((plugin) =>
    overlay.kept.has(pluginRef(plugin)),
  );
  const ownership = planOwnership({
    previous: (previouslyManaged ?? []).filter((plugin) => !keptOverlay.includes(plugin)),
    selected: plugins,
    available,
    keyOf: pluginRef,
  });

  const failures: Array<PluginFailure> = [];
  for (const harness of HARNESSES) {
    applyHarness(runtime, harness, plugins, available, failures, options.update);
  }

  writePiPlugins(runtime, plugins);

  if (failures.length > 0) {
    return reportPluginFailures(runtime, failures);
  }

  if (previouslyManaged === undefined) {
    if (available.length === 0) {
      writeLine(runtime.stdout, "No managed plugins lock found; skipping ownership initialization");
      writeLine(runtime.stdout, "Done.");
      return 0;
    }
    writeLine(
      runtime.stdout,
      "Initializing managed plugins lock without removing existing plugins",
    );
    writePluginLock(pluginLockPath, withKept(ownership.nextLock([]), keptOverlay), overlay.next);
    writeLine(runtime.stdout, "Done.");
    return 0;
  }

  const deferred = removeStalePlugins(runtime, ownership.removals, available, failures);
  if (failures.length > 0) {
    return reportPluginFailures(runtime, failures);
  }

  writePluginLock(
    pluginLockPath,
    withKept(ownership.nextLock(deferred), keptOverlay),
    overlay.next,
  );
  writeLine(runtime.stdout, "Done.");
  return 0;
}

function reportPluginFailures(runtime: Runtime, failures: ReadonlyArray<PluginFailure>): 1 {
  return reportSyncFailures(runtime, failures, "Plugin sync", ["failure", "failures"], "plugin");
}

export function main(args: ReadonlyArray<string>, runtime: Runtime = createRuntime()): number {
  const parsed = parseSyncArgs(args, USAGE, true);
  if (parsed.kind === "help") {
    writeLine(runtime.stdout, USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    writeLine(runtime.stderr, parsed.message);
    return 2;
  }

  try {
    return withManagedLock(runtime.env, "plugins", () =>
      apply(runtime, { profile: parsed.profile, update: parsed.update }),
    );
  } catch (error) {
    writeLine(runtime.stderr, `Plugin sync failed: ${errorMessage(error)}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === import.meta.filename) {
  runMain(
    Effect.sync(() => {
      process.exitCode = main(process.argv.slice(2));
    }),
  );
}
