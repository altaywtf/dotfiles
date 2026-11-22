import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Option, Schema } from "effect";

import { writeLine } from "./runtime.ts";
import type { Runtime } from "./runtime.ts";

const MANIFEST_PATHS = [
  "plugin.json",
  ".antigravity-plugin/plugin.json",
  ".gemini-plugin/plugin.json",
] as const;

const AgyPluginToggle = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
});

const AgyConfig = Schema.Struct({
  plugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const AgyPluginManifest = Schema.Struct({
  disabled: Schema.optional(Schema.Boolean),
});

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function readPluginOverrides(configPath: string): ReadonlyMap<string, boolean> {
  if (!existsSync(configPath)) {
    return new Map();
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return new Map();
  }
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(AgyConfig))(raw);
  if (Option.isNone(parsed) || parsed.value.plugins === undefined) {
    return new Map();
  }
  const overrides = new Map<string, boolean>();
  for (const [name, entry] of Object.entries(parsed.value.plugins)) {
    const toggle = Schema.decodeUnknownOption(AgyPluginToggle)(entry);
    if (Option.isSome(toggle) && toggle.value.enabled !== undefined) {
      overrides.set(name, toggle.value.enabled);
    }
  }
  return overrides;
}

function readPluginManifest(pluginDir: string): typeof AgyPluginManifest.Type | undefined {
  for (const candidate of MANIFEST_PATHS) {
    const manifestPath = join(pluginDir, candidate);
    if (!existsSync(manifestPath)) {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch {
      return undefined;
    }
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(AgyPluginManifest))(raw);
    return Option.isSome(parsed) ? parsed.value : undefined;
  }
  return undefined;
}

function readEnabledUserPlugins(
  userPluginsDir: string,
  overrides: ReadonlyMap<string, boolean>,
): ReadonlyMap<string, string> {
  if (!existsSync(userPluginsDir)) {
    return new Map();
  }
  const enabled = new Map<string, string>();
  for (const entry of readdirSync(userPluginsDir)) {
    if (entry.startsWith(".")) {
      continue;
    }
    const pluginDir = join(userPluginsDir, entry);
    if (!statOrUndefined(pluginDir)?.isDirectory()) {
      continue;
    }
    const manifest = readPluginManifest(pluginDir);
    if (manifest === undefined) {
      continue;
    }
    const override = overrides.get(entry);
    if (override === false || (manifest.disabled === true && override !== true)) {
      continue;
    }
    enabled.set(entry, resolve(pluginDir));
  }
  return enabled;
}

function isInsideDirectory(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function syncProfilePlugins(
  runtime: Runtime,
  profilePluginsDir: string,
  userPluginsDir: string,
  enabledPlugins: ReadonlyMap<string, string>,
): void {
  const existing = lstatOrUndefined(profilePluginsDir);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      return;
    }
  } else {
    if (enabledPlugins.size === 0) {
      return;
    }
    mkdirSync(profilePluginsDir, { recursive: true });
  }

  for (const entry of readdirSync(profilePluginsDir)) {
    const entryPath = join(profilePluginsDir, entry);
    const stat = lstatOrUndefined(entryPath);
    if (!stat?.isSymbolicLink()) {
      continue;
    }
    const resolvedTarget = resolve(dirname(entryPath), readlinkSync(entryPath));
    if (!isInsideDirectory(resolvedTarget, userPluginsDir)) {
      continue;
    }
    if (enabledPlugins.get(entry) !== resolvedTarget) {
      unlinkSync(entryPath);
      writeLine(runtime.stdout, `Antigravity (T3): unlinked ${entry} from ${profilePluginsDir}`);
    }
  }

  for (const [name, sourcePath] of enabledPlugins) {
    const linkPath = join(profilePluginsDir, name);
    if (lstatOrUndefined(linkPath) !== undefined) {
      continue;
    }
    symlinkSync(sourcePath, linkPath);
    writeLine(runtime.stdout, `Antigravity (T3): linked ${name} into ${profilePluginsDir}`);
  }
}

export function linkT3AgyPlugins(runtime: Runtime): void {
  if (!runtime.commandExists("agy")) {
    return;
  }
  const home = runtime.env.HOME;
  if (!home) {
    throw new Error("HOME is required to locate Antigravity plugins");
  }
  const t3ProfilesDir = join(home, ".t3/userdata/providers/antigravity");
  if (!statOrUndefined(t3ProfilesDir)?.isDirectory()) {
    return;
  }
  const userConfigDir = join(home, ".gemini/config");
  const userPluginsDir = resolve(join(userConfigDir, "plugins"));
  const overrides = readPluginOverrides(join(userConfigDir, "config.json"));
  const enabledPlugins = readEnabledUserPlugins(userPluginsDir, overrides);

  for (const entry of readdirSync(t3ProfilesDir)) {
    if (entry.startsWith(".")) {
      continue;
    }
    const configDir = join(t3ProfilesDir, entry, "config");
    if (!statOrUndefined(configDir)?.isDirectory()) {
      continue;
    }
    syncProfilePlugins(runtime, join(configDir, "plugins"), userPluginsDir, enabledPlugins);
  }
}
