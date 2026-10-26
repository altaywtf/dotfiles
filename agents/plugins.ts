#!/usr/bin/env node

import { sanitizeDiagnostic } from "../lib/diagnostics.ts";

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile, type AgentLayer } from "../profiles/model.ts";
import {
  composeLayers,
  type Harness,
  HARNESS_INFO,
  HARNESSES,
  isSafeName,
  parseSyncArgs,
  readHarnesses,
  reportSyncFailures,
  type SyncFailure,
} from "./harness.ts";
import { readLocalOverlay } from "./local.ts";
import { planOwnership } from "./ownership.ts";
import {
  guardOverlay,
  managedLockLocation,
  type OverlayOwnership,
  readLockFile,
  readOverlayOwnership,
  withManagedLock,
  writeLockFile,
} from "./lock.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  writeLine,
} from "./runtime.ts";

export { HARNESSES } from "./harness.ts";

// `owner/repo` as accepted by the marketplace-add subcommands.
const GITHUB_MARKETPLACE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// scp-like SSH Git source, such as `git@host:owner/repo.git`.
const SCP_MARKETPLACE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

// Both harnesses accept owner/repo, an HTTPS or SSH Git URL, or a local path.
// URLs must not embed credentials: the source lands in harness config and locks.
function isMarketplaceSource(source: string): boolean {
  if (GITHUB_MARKETPLACE.test(source) || SCP_MARKETPLACE.test(source)) return true;
  if (isAbsolute(source)) return true;
  if (!URL.canParse(source)) return false;
  const url = new URL(source);
  return (
    (url.protocol === "https:" && url.username === "" && url.password === "") ||
    (url.protocol === "ssh:" && url.password === "")
  );
}

export type Plugin = {
  marketplace: string;
  marketplaceId: string;
  name: string;
  harnesses: readonly Harness[];
};

type PlannedCommand = {
  command: string;
  args: readonly string[];
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
    // `marketplace upgrade` refreshes Git snapshots only; a local path is read in place.
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

function readManifestHarnesses(value: unknown, context: string, name: string): readonly Harness[] {
  if (value === undefined) {
    return HARNESSES;
  }
  return readHarnesses(
    value,
    `${context}: ${name} harnesses must be a unique non-empty subset of ${HARNESSES.join(", ")}`,
  );
}

function readPlugin(value: unknown, context: string): Plugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("marketplace" in value) ||
    typeof value.marketplace !== "string" ||
    !isMarketplaceSource(value.marketplace) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !isSafeName(value.name)
  ) {
    throw new Error(
      `${context}: expected a marketplace (owner/repo, HTTPS or SSH Git URL without credentials, or absolute path) and a safe plugin name`,
    );
  }

  // Harnesses register a marketplace under the name its manifest declares, which is the
  // repository name for every marketplace we ship; `marketplaceId` overrides the divergent case.
  // Other sources have no repository name to derive it from.
  const repository = GITHUB_MARKETPLACE.test(value.marketplace)
    ? value.marketplace.split("/")[1]
    : undefined;
  const marketplaceId =
    "marketplaceId" in value && value.marketplaceId !== undefined
      ? value.marketplaceId
      : repository;
  if (marketplaceId === undefined) {
    throw new Error(
      `${context}: ${value.name} needs a marketplaceId because its marketplace is not owner/repo`,
    );
  }
  if (typeof marketplaceId !== "string" || !isSafeName(marketplaceId)) {
    throw new Error(`${context}: ${value.name} marketplaceId must be a safe name`);
  }

  const harnesses = readManifestHarnesses(
    "harnesses" in value ? value.harnesses : undefined,
    context,
    value.name,
  );
  return { marketplace: value.marketplace, marketplaceId, name: value.name, harnesses };
}

function parsePlugins(value: unknown, context: string): Plugin[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected a plugins array`);
  }
  const plugins = value.map((plugin) => readPlugin(plugin, context));
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

export function readPlugins(manifestPath: string): Plugin[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid plugins manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || !("plugins" in parsed)) {
    throw new Error(`Invalid plugins manifest at ${manifestPath}: expected a plugins array`);
  }
  return parsePlugins(parsed.plugins, `Invalid plugins manifest at ${manifestPath}`);
}

export type PluginLayer = AgentLayer | "local";

export function readLayeredPlugins(
  repoDir: string,
  profile: string,
  layers: readonly AgentLayer[],
): {
  layers: readonly PluginLayer[];
  plugins: Plugin[];
  localPath?: string;
  localNames?: string[];
} {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent plugins`);
  }

  const manifests = new Map<PluginLayer, Plugin[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    manifests.set(layer, readPlugins(join(repoDir, "agents", "plugins", `${layer}.json`)));
  }

  const selected: PluginLayer[] = [...layers];
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
  plugins: Plugin[];
  overlays?: OverlayOwnership;
};

function readLockedPlugin(value: unknown, lockPath: string): Plugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("marketplace" in value) ||
    typeof value.marketplace !== "string" ||
    !isMarketplaceSource(value.marketplace) ||
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

function writePluginLock(
  lockPath: string,
  plugins: readonly Plugin[],
  overlays?: OverlayOwnership,
): void {
  const lock: PluginLock = { version: 1, plugins: [...plugins], ...(overlays ? { overlays } : {}) };
  writeLockFile(lockPath, lock);
}

// Another checkout's overlay keeps its harnesses even when this checkout selects the same ref.
function withKept(next: readonly Plugin[], kept: readonly Plugin[]): Plugin[] {
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

function uninstallArgs(harness: Harness, plugin: Plugin): string[] {
  switch (harness) {
    case "claude":
      return ["plugin", "uninstall", "-y", pluginRef(plugin)];
    case "codex":
      return ["plugin", "remove", pluginRef(plugin)];
  }
}

// Claude exits 1 when asked to uninstall a plugin it no longer has; Codex exits 0.
function alreadyUninstalled(harness: Harness, output: string): boolean {
  return harness === "claude" && /not found in installed plugins/.test(output);
}

function removeStalePlugins(
  runtime: Runtime,
  stale: readonly Plugin[],
  available: readonly Harness[],
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
  plugins: readonly Plugin[],
  available: readonly Harness[],
  failures: PluginFailure[],
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

// A signed-out Claude, such as one under launchd without keychain access, lists
// no plugins, so planning against it would install copies that shadow synced ones.
function claudeSignedIn(runtime: Runtime): boolean {
  const result = runtime.run(HARNESS_SPECS.claude.binary, ["auth", "status"], {
    stdout: "capture",
    stderr: "capture",
  });
  let parsed: unknown;
  try {
    if (result.status !== 0) {
      throw new Error(`exit ${result.status}`);
    }
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    writeLine(
      runtime.stdout,
      `Claude: could not read sign-in status (${errorMessage(error)}); leaving plugins unchanged`,
    );
    return false;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("loggedIn" in parsed) ||
    parsed.loggedIn !== true
  ) {
    writeLine(runtime.stdout, "Claude: not signed in for this run; leaving plugins unchanged");
    return false;
  }
  return true;
}

type ClaudeInstall = { id: string; scope?: string };

// Claude loads plugins enabled on claude.ai as `<name>@synced`, and a same-named
// marketplace install shadows them, so the sync yields those names to claude.ai.
function readClaudeInstalls(runtime: Runtime): readonly ClaudeInstall[] {
  const result = runtime.run(HARNESS_SPECS.claude.binary, ["plugin", "list", "--json"], {
    stdout: "capture",
    stderr: "capture",
  });
  let parsed: unknown;
  try {
    if (result.status !== 0) {
      throw new Error(`exit ${result.status}`);
    }
    parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) {
      throw new Error("expected an array");
    }
  } catch (error) {
    writeLine(
      runtime.stdout,
      `Claude: could not read synced plugins (${errorMessage(error)}); installing every selected plugin`,
    );
    return [];
  }

  return parsed.flatMap((entry: unknown): ClaudeInstall[] => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      ("enabled" in entry && entry.enabled === false)
    ) {
      return [];
    }
    const scope = "scope" in entry && typeof entry.scope === "string" ? entry.scope : undefined;
    return [{ id: entry.id, scope }];
  });
}

function syncedClaudePlugins(installs: readonly ClaudeInstall[]): ReadonlySet<string> {
  return new Set(
    installs
      .filter((install) => install.id.endsWith("@synced"))
      .map((install) => install.id.slice(0, -"@synced".length)),
  );
}

// Uninstalls user-scope marketplace installs that shadow a selected synced plugin.
// Returns the refs it removed so ownership pruning does not uninstall them twice.
function removeShadowingClaudeInstalls(
  runtime: Runtime,
  plugins: readonly Plugin[],
  installs: readonly ClaudeInstall[],
  failures: PluginFailure[],
): ReadonlySet<string> {
  const synced = syncedClaudePlugins(installs);
  const names = new Set(
    plugins
      .filter((plugin) => plugin.harnesses.includes("claude") && synced.has(plugin.name))
      .map((plugin) => plugin.name),
  );
  const removed = new Set<string>();

  for (const install of installs) {
    const separator = install.id.lastIndexOf("@");
    const name = install.id.slice(0, separator);
    const marketplaceId = install.id.slice(separator + 1);
    if (
      separator <= 0 ||
      marketplaceId === "synced" ||
      !names.has(name) ||
      (install.scope !== undefined && install.scope !== "user")
    ) {
      continue;
    }

    writeLine(
      runtime.stdout,
      `Claude: ${install.id} shadows ${name}@synced from claude.ai; uninstalling`,
    );
    const args = ["plugin", "uninstall", "-y", install.id];
    const result = runtime.run(HARNESS_SPECS.claude.binary, args, {
      stdout: "capture",
      stderr: "capture",
    });
    if (result.status === 0) {
      removed.add(install.id);
    } else {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${HARNESS_SPECS.claude.label}: ${args.join(" ")} (exit ${result.status})`,
      });
    }
  }
  return removed;
}

function yieldSyncedClaudePlugins(
  runtime: Runtime,
  plugins: readonly Plugin[],
  synced: ReadonlySet<string>,
): Plugin[] {
  return plugins.flatMap((plugin) => {
    if (!plugin.harnesses.includes("claude") || !synced.has(plugin.name)) {
      return [plugin];
    }
    writeLine(
      runtime.stdout,
      `Claude: ${pluginRef(plugin)} is synced from claude.ai; not installing`,
    );
    const harnesses = plugin.harnesses.filter((harness) => harness !== "claude");
    return harnesses.length > 0 ? [{ ...plugin, harnesses }] : [];
  });
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
  const layered = readLayeredPlugins(repoDir, profileName, profile.agentLayers);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `Plugin layers: ${layered.layers.join(", ")}`);
  if (layered.localPath) writeLine(runtime.stdout, `Local overlay: ${layered.localPath}`);
  const available = HARNESSES.filter(
    (harness) =>
      runtime.commandExists(HARNESS_INFO[harness].binary) &&
      (harness !== "claude" || claudeSignedIn(runtime)),
  );
  const installs = available.includes("claude") ? readClaudeInstalls(runtime) : [];
  const synced = syncedClaudePlugins(installs);
  const plugins = yieldSyncedClaudePlugins(runtime, layered.plugins, synced);

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

  const failures: PluginFailure[] = [];
  const unshadowed = removeShadowingClaudeInstalls(runtime, layered.plugins, installs, failures);
  for (const harness of HARNESSES) {
    applyHarness(runtime, harness, plugins, available, failures, options.update);
  }

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

  // A synced plugin with no user-scope install left needs no uninstall; claude.ai owns it in
  // Claude. `plugin uninstall` acts on user scope only, so other scopes don't count.
  const installed = new Set(
    installs
      .filter((install) => install.scope === undefined || install.scope === "user")
      .map((install) => install.id),
  );
  const removals = ownership.removals.flatMap((plugin) => {
    const ref = pluginRef(plugin);
    const syncedOnly = synced.has(plugin.name) && !installed.has(ref);
    if (!unshadowed.has(ref) && !syncedOnly) {
      return [plugin];
    }
    const harnesses = plugin.harnesses.filter((harness) => harness !== "claude");
    return harnesses.length > 0 ? [{ ...plugin, harnesses }] : [];
  });
  const deferred = removeStalePlugins(runtime, removals, available, failures);
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
