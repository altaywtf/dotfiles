#!/usr/bin/env node

import { sanitizeDiagnostic } from "../lib/diagnostics.ts";

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile, type AgentLayer } from "../profiles/model.ts";
import {
  composeLayers,
  type Harness,
  HARNESS_INFO,
  HARNESSES,
  harnessPresent,
  isSafeName,
  parseSyncArgs,
  readHarnesses,
  reportSyncFailures,
  type SyncFailure,
} from "./harness.ts";
import { planOwnership } from "./ownership.ts";
import { readLockFile, writeLockFile, managedLockLocation, withManagedLock } from "./lock.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  writeLine,
} from "./runtime.ts";

export { type Harness, HARNESSES } from "./harness.ts";

// `owner/repo` as accepted by the marketplace-add subcommands.
const MARKETPLACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type Plugin = {
  marketplace: string;
  marketplaceId: string;
  name: string;
  harnesses: readonly Harness[];
};

export type PlannedCommand = {
  command: string;
  args: readonly string[];
  // Set on install commands whose harness installs a whole marketplace repository,
  // so apply can skip sources its CLI already lists.
  marketplace?: string;
  plugin?: string;
  // Refresh commands must not run after their marketplace add or plugin install failed.
  refresh?: boolean;
};

type PluginFailure = SyncFailure;

type HarnessSpec = {
  binary: string;
  label: string;
  marketplaceArgs?: (plugin: Plugin) => string[];
  // Codex refreshes Git marketplace snapshots by configured name, not plugin ref.
  upgradeMarketplaceArgs?: (plugin: Plugin) => string[];
  installArgs?: (plugin: Plugin) => string[];
  // `--update` refreshes an already-installed plugin. Claude needs `-y` because
  // apply captures stdout and is therefore not a TTY.
  updateArgs?: (plugin: Plugin) => string[];
  // Grok installs a source repository once, not a plugin ref, and re-installing
  // an installed source exits non-zero; apply consults `plugin list` first.
  installsMarketplace?: {
    listArgs: readonly string[];
    installed(listOutput: string, plugin: Plugin): boolean;
  };
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
    upgradeMarketplaceArgs: (plugin) => ["plugin", "marketplace", "upgrade", plugin.marketplaceId],
    installArgs: (plugin) => ["plugin", "add", pluginRef(plugin)],
  },
  grok: {
    ...HARNESS_INFO.grok,
    installArgs: (plugin) => ["plugin", "install", plugin.marketplace, "--trust"],
    updateArgs: (plugin) => ["plugin", "update", plugin.name],
    installsMarketplace: {
      listArgs: ["plugin", "list"],
      installed: (listOutput, plugin) =>
        listOutput.includes(`git: https://github.com/${plugin.marketplace}]`),
    },
  },
};

export function pluginRef(plugin: Plugin): string {
  return `${plugin.name}@${plugin.marketplaceId}`;
}

function readManifestHarnesses(
  value: unknown,
  manifestPath: string,
  name: string,
): readonly Harness[] {
  if (value === undefined) {
    return HARNESSES;
  }
  return readHarnesses(
    value,
    `Invalid plugins manifest at ${manifestPath}: ${name} harnesses must be a unique non-empty subset of ${HARNESSES.join(", ")}`,
  );
}

function readPlugin(value: unknown, manifestPath: string): Plugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("marketplace" in value) ||
    typeof value.marketplace !== "string" ||
    !MARKETPLACE_PATTERN.test(value.marketplace) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !isSafeName(value.name)
  ) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: expected owner/repo marketplace and safe plugin name strings`,
    );
  }

  const repository = value.marketplace.split("/")[1] ?? "";
  // Harnesses register a marketplace under the name its manifest declares, which is the
  // repository name for every marketplace we ship; `marketplaceId` overrides the divergent case.
  const marketplaceId =
    "marketplaceId" in value && value.marketplaceId !== undefined
      ? value.marketplaceId
      : repository;
  if (typeof marketplaceId !== "string" || !isSafeName(marketplaceId)) {
    throw new Error(
      `Invalid plugins manifest at ${manifestPath}: ${value.name} marketplaceId must be a safe name`,
    );
  }

  const harnesses = readManifestHarnesses(
    "harnesses" in value ? value.harnesses : undefined,
    manifestPath,
    value.name,
  );
  return { marketplace: value.marketplace, marketplaceId, name: value.name, harnesses };
}

export function readPlugins(manifestPath: string): Plugin[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid plugins manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("plugins" in parsed) ||
    !Array.isArray(parsed.plugins)
  ) {
    throw new Error(`Invalid plugins manifest at ${manifestPath}: expected a plugins array`);
  }

  const plugins = parsed.plugins.map((plugin) => readPlugin(plugin, manifestPath));
  const refs = new Set<string>();
  for (const plugin of plugins) {
    const ref = pluginRef(plugin);
    if (refs.has(ref)) {
      throw new Error(
        `Invalid plugins manifest at ${manifestPath}: ${ref} is defined more than once`,
      );
    }
    refs.add(ref);
  }
  return plugins;
}

export function readLayeredPlugins(
  repoDir: string,
  profile: string,
  layers: readonly AgentLayer[],
): { layers: readonly AgentLayer[]; plugins: Plugin[] } {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent plugins`);
  }

  const manifests = new Map<AgentLayer, Plugin[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    manifests.set(layer, readPlugins(join(repoDir, "agents", "plugins", `${layer}.json`)));
  }

  const plugins = composeLayers(
    layers,
    manifests,
    pluginRef,
    (ref) => `Invalid layered plugins: ${ref} is defined more than once`,
  );
  // Marketplace registration is planned once per repository, so every plugin
  // from one repository must install against the same registered id.
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
  return { layers, plugins };
}

type PluginLock = {
  version: 1;
  plugins: Plugin[];
};

function readLockedPlugin(value: unknown, lockPath: string): Plugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("marketplace" in value) ||
    typeof value.marketplace !== "string" ||
    !MARKETPLACE_PATTERN.test(value.marketplace) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !isSafeName(value.name) ||
    !("marketplaceId" in value) ||
    typeof value.marketplaceId !== "string" ||
    !isSafeName(value.marketplaceId) ||
    !("harnesses" in value)
  ) {
    throw new Error(
      `Invalid managed plugins lock at ${lockPath}: expected explicit marketplace, marketplaceId, name, and harnesses`,
    );
  }

  return {
    marketplace: value.marketplace,
    marketplaceId: value.marketplaceId,
    name: value.name,
    harnesses: readHarnesses(
      value.harnesses,
      `Invalid managed plugins lock at ${lockPath}: ${value.name} harnesses must be an explicit unique non-empty subset of ${HARNESSES.join(", ")}`,
    ),
  };
}

function readPluginLock(lockPath: string): Plugin[] | undefined {
  const parsed = readLockFile(lockPath, "plugins");
  if (parsed === undefined) {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("plugins" in parsed) ||
    !Array.isArray(parsed.plugins)
  ) {
    throw new Error(
      `Invalid managed plugins lock at ${lockPath}: expected version 1 and a plugins array`,
    );
  }

  const plugins = parsed.plugins.map((plugin: unknown) => readLockedPlugin(plugin, lockPath));
  const refs = plugins.map(pluginRef);
  if (new Set(refs).size !== refs.length) {
    throw new Error(`Invalid managed plugins lock at ${lockPath}: plugin refs must be unique`);
  }
  return plugins;
}

function writePluginLock(lockPath: string, plugins: readonly Plugin[]): void {
  const lock: PluginLock = { version: 1, plugins: [...plugins] };
  writeLockFile(lockPath, lock);
}

function uninstallArgs(harness: Harness, plugin: Plugin): string[] {
  switch (harness) {
    case "claude":
      return ["plugin", "uninstall", "-y", pluginRef(plugin)];
    case "codex":
      return ["plugin", "remove", pluginRef(plugin)];
    case "grok":
      return ["plugin", "uninstall", plugin.name, "--confirm"];
  }
}

function removeStalePlugins(
  runtime: Runtime,
  stale: readonly Plugin[],
  failures: PluginFailure[],
): Plugin[] {
  const leftover: Plugin[] = [];

  for (const plugin of stale) {
    const leftoverHarnesses: Harness[] = [];
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

      const args = uninstallArgs(harness, plugin);

      writeLine(
        runtime.stdout,
        `Removing stale managed plugin: ${pluginRef(plugin)} from ${spec.label}`,
      );
      const result = runtime.run(spec.binary, args, { stdout: "capture", stderr: "capture" });
      if (result.status !== 0) {
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

export function planHarness(
  harness: Harness,
  plugins: readonly Plugin[],
  options: { update?: boolean } = {},
): PlannedCommand[] {
  const spec = HARNESS_SPECS[harness];
  const selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));
  const planned: PlannedCommand[] = [];
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
      if (options.update === true && spec.upgradeMarketplaceArgs !== undefined) {
        planned.push({
          command: spec.binary,
          args: spec.upgradeMarketplaceArgs(plugin),
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

  if (spec.installsMarketplace !== undefined) {
    const installed = new Set<string>();
    for (const plugin of selected) {
      if (installed.has(plugin.marketplace)) {
        continue;
      }
      installed.add(plugin.marketplace);
      planned.push({
        command: spec.binary,
        args: installArgs(plugin),
        marketplace: plugin.marketplace,
      });
    }
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

function grokListedPluginName(listOutput: string, plugin: Plugin): string | undefined {
  return listOutput.includes(`: ${plugin.name} [git: https://github.com/${plugin.marketplace}]`)
    ? plugin.name
    : undefined;
}

function refreshInstalledMarketplace(
  runtime: Runtime,
  spec: HarnessSpec,
  selected: readonly Plugin[],
  marketplace: string,
  listOutput: string,
  failures: PluginFailure[],
): void {
  const names = [
    ...new Set(
      selected
        .filter((plugin) => plugin.marketplace === marketplace)
        .map((plugin) => grokListedPluginName(listOutput, plugin))
        .filter((name): name is string => name !== undefined),
    ),
  ];
  if (names.length === 0) {
    failures.push({
      diagnostic: `${marketplace} is already installed, but Grok did not report a managed plugin name to update`,
      summary: `${spec.label}: ${marketplace} could not be refreshed`,
    });
    return;
  }

  const updateArgs = spec.updateArgs;
  if (updateArgs === undefined) {
    failures.push({
      diagnostic: `${marketplace} is already installed, and ${spec.label} has no non-interactive update command`,
      summary: `${spec.label}: ${marketplace} could not be refreshed`,
    });
    return;
  }

  for (const name of names) {
    const plugin = selected.find(
      (candidate) => candidate.marketplace === marketplace && candidate.name === name,
    );
    if (plugin === undefined) {
      continue;
    }
    const args = updateArgs(plugin);
    writeLine(runtime.stdout, `${spec.label}: ${spec.binary} ${args.join(" ")}`);
    const result = runtime.run(spec.binary, args, { stdout: "capture", stderr: "capture" });
    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${spec.label}: ${args.join(" ")} (exit ${result.status})`,
      });
    }
  }
}

function applyHarness(
  runtime: Runtime,
  harness: Harness,
  plugins: readonly Plugin[],
  failures: PluginFailure[],
  update: boolean,
): void {
  const spec = HARNESS_SPECS[harness];
  const selected = plugins.filter((plugin) => plugin.harnesses.includes(harness));

  if (!runtime.commandExists(spec.binary)) {
    writeLine(runtime.stdout, `Skipping ${spec.label} plugins: '${spec.binary}' is not installed`);
    return;
  }

  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${spec.label} plugins are selected for this profile`);
    return;
  }

  let installedSources = "";
  const guard = spec.installsMarketplace;
  if (guard !== undefined) {
    const listed = runtime.run(spec.binary, [...guard.listArgs], {
      stdout: "capture",
      stderr: "capture",
    });
    if (listed.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${listed.stdout}\n${listed.stderr}`),
        summary: `${spec.label}: ${guard.listArgs.join(" ")} (exit ${listed.status})`,
      });
      return;
    }
    installedSources = listed.stdout;
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
    if (guard !== undefined && planned.marketplace !== undefined) {
      const plugin = selected.find((candidate) => candidate.marketplace === planned.marketplace);
      if (plugin !== undefined && guard.installed(installedSources, plugin)) {
        if (update) {
          refreshInstalledMarketplace(
            runtime,
            spec,
            selected,
            planned.marketplace,
            installedSources,
            failures,
          );
          continue;
        }
        writeLine(runtime.stdout, `${spec.label}: ${planned.marketplace} is already installed`);
        continue;
      }
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

type PluginOptions = {
  profile?: string;
  update: boolean;
};

const USAGE = "Usage: ./agents/plugins.ts [--profile PROFILE] [--update]";

function apply(runtime: Runtime, options: PluginOptions): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { layers, plugins } = readLayeredPlugins(repoDir, profileName, profile.agentLayers);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `Plugin layers: ${layers.join(", ")}`);

  const pluginLockPath = managedLockLocation(runtime.env, "plugins");
  const previouslyManaged = readPluginLock(pluginLockPath);
  const ownership = planOwnership({
    previous: previouslyManaged ?? [],
    selected: plugins,
    available: HARNESSES.filter((harness) => runtime.commandExists(HARNESS_INFO[harness].binary)),
    keyOf: pluginRef,
  });

  const failures: PluginFailure[] = [];
  for (const harness of HARNESSES) {
    applyHarness(runtime, harness, plugins, failures, options.update);
  }

  if (failures.length > 0) {
    return reportPluginFailures(runtime, failures);
  }

  if (previouslyManaged === undefined) {
    if (!harnessPresent(runtime)) {
      writeLine(runtime.stdout, "No managed plugins lock found; skipping ownership initialization");
      writeLine(runtime.stdout, "Done.");
      return 0;
    }
    writeLine(
      runtime.stdout,
      "Initializing managed plugins lock without removing existing plugins",
    );
    writePluginLock(pluginLockPath, ownership.nextLock([]));
    writeLine(runtime.stdout, "Done.");
    return 0;
  }

  const deferred = removeStalePlugins(runtime, ownership.removals, failures);
  if (failures.length > 0) {
    return reportPluginFailures(runtime, failures);
  }

  writePluginLock(pluginLockPath, ownership.nextLock(deferred));
  writeLine(runtime.stdout, "Done.");
  return 0;
}

function reportPluginFailures(runtime: Runtime, failures: readonly PluginFailure[]): 1 {
  return reportSyncFailures(runtime, failures, "Plugin sync", ["failure", "failures"], "plugin");
}

export function main(args: readonly string[], runtime: Runtime = createRuntime()): number {
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
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runMain(
    Effect.sync(() => {
      process.exitCode = main(process.argv.slice(2));
    }),
  );
}
