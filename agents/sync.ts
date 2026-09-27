#!/usr/bin/env node

import { sanitizeDiagnostic } from "../lib/diagnostics.ts";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { readLayeredSkills, readSkillLock, type Skill } from "./skills/catalog.ts";
import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import {
  guardOverlay,
  managedLockPath,
  readOverlayOwnership,
  writeLockFile,
  type OverlayOwnership,
} from "./lock.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  writeLine,
} from "./runtime.ts";

export { type Runtime } from "./runtime.ts";

// renovate: datasource=npm depName=skills
export const DEFAULT_SKILLS_CLI_VERSION = "1.7.0";

type Agent = "claude-code" | "codex";

type SkillFailure = {
  diagnostic: string;
  summary: string;
};

type SkillLock = {
  version: 1;
  skills: Skill[];
  overlays?: OverlayOwnership;
};

function writeSkillLock(
  lockPath: string,
  skills: readonly Skill[],
  overlays: OverlayOwnership | undefined,
): void {
  const lock: SkillLock = { version: 1, skills: [...skills], ...(overlays ? { overlays } : {}) };
  writeLockFile(lockPath, lock);
}

function findInstalledAgents(runtime: Runtime): Agent[] {
  const agents: Agent[] = [];

  if (runtime.commandExists("claude")) {
    agents.push("claude-code");
  } else {
    writeLine(runtime.stdout, "Skipping Claude Code skills: 'claude' is not installed");
  }

  if (runtime.commandExists("codex")) {
    agents.push("codex");
  } else {
    writeLine(runtime.stdout, "Skipping Codex skills: 'codex' is not installed");
  }

  return agents;
}

function installedSkillError(home: string, skill: Skill): string | undefined {
  const manifestPath = join(home, ".agents", "skills", skill.name, "SKILL.md");
  if (!existsSync(manifestPath)) {
    return `installer reported success but ${manifestPath} is missing`;
  }

  const manifest = readFileSync(manifestPath, "utf8");
  const frontmatter = manifest.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter === null) {
    return `installer reported success but ${manifestPath} has no YAML frontmatter`;
  }

  const name = frontmatter[1]
    ?.split(/\r?\n/)
    .find((line) => line.startsWith("name:"))
    ?.slice("name:".length)
    .trim();
  if (name !== skill.name) {
    return `installer reported success but ${manifestPath} declares name ${name ?? "<missing>"}`;
  }

  return undefined;
}

function installSkills(
  runtime: Runtime,
  skills: readonly Skill[],
  agents: readonly Agent[],
  cliVersion: string,
  home: string,
): number {
  const failures: SkillFailure[] = [];

  for (const skill of skills) {
    writeLine(runtime.stdout, `Installing skill: ${skill.name} from ${skill.source}`);
    const result = runtime.run(
      "pnpm",
      [
        "dlx",
        `skills@${cliVersion}`,
        "add",
        skill.source,
        "-g",
        "-y",
        "-a",
        ...agents,
        "-s",
        skill.name,
      ],
      { stdout: "capture", stderr: "capture" },
    );

    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${skill.name} (${skill.source}, exit ${result.status})`,
      });
      continue;
    }

    const artifactError = installedSkillError(home, skill);
    if (artifactError !== undefined) {
      failures.push({
        diagnostic: artifactError,
        summary: `${skill.name} (${skill.source}, invalid installed artifact)`,
      });
    }
  }

  if (failures.length === 0) {
    return 0;
  }

  const noun = failures.length === 1 ? "skill" : "skills";
  writeLine(runtime.stderr, `Skill installation failed for ${failures.length} ${noun}:`);
  for (const failure of failures) {
    writeLine(runtime.stderr, `  - ${failure.summary}`);
    for (const line of failure.diagnostic.split("\n")) {
      if (line.length > 0) {
        writeLine(runtime.stderr, `    ${line}`);
      }
    }
  }
  writeLine(runtime.stderr, "Fix the reported installer failures, then rerun sync.");
  return 1;
}

function updateGlobalSkills(runtime: Runtime, cliVersion: string): number {
  writeLine(runtime.stdout, "Updating globally installed skills...");
  const result = runtime.run("pnpm", ["dlx", `skills@${cliVersion}`, "update", "-g", "-y"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.status === 0) {
    return 0;
  }

  writeLine(
    runtime.stderr,
    `Global skill update failed (exit ${result.status}). Manifest sync already completed; fix the updater and rerun with --update.`,
  );
  return 1;
}

function removeSkills(
  runtime: Runtime,
  skills: readonly Skill[],
  cliVersion: string,
  home: string,
): number {
  const failures: SkillFailure[] = [];

  for (const skill of skills) {
    writeLine(runtime.stdout, `Removing stale managed skill: ${skill.name}`);
    const result = runtime.run(
      "pnpm",
      ["dlx", `skills@${cliVersion}`, "remove", skill.name, "-g", "-y"],
      { stdout: "capture", stderr: "capture" },
    );

    if (result.status !== 0) {
      failures.push({
        diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
        summary: `${skill.name} (exit ${result.status})`,
      });
      continue;
    }

    const skillDirectory = join(home, ".agents", "skills", skill.name);
    if (existsSync(skillDirectory)) {
      failures.push({
        diagnostic: `remover reported success but ${skillDirectory} still exists`,
        summary: `${skill.name} (invalid removal result)`,
      });
    }
  }

  if (failures.length === 0) {
    return 0;
  }

  const noun = failures.length === 1 ? "skill" : "skills";
  writeLine(runtime.stderr, `Managed skill removal failed for ${failures.length} ${noun}:`);
  for (const failure of failures) {
    writeLine(runtime.stderr, `  - ${failure.summary}`);
    for (const line of failure.diagnostic.split("\n")) {
      if (line.length > 0) {
        writeLine(runtime.stderr, `    ${line}`);
      }
    }
  }
  writeLine(runtime.stderr, "Fix the reported removal failures, then rerun sync.");
  return 1;
}

type SyncOptions = {
  profile?: string;
  update: boolean;
};

type ParsedArgs =
  | { kind: "run"; options: SyncOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

const USAGE = "Usage: ./agents/sync.ts [--profile PROFILE] [--update]";

function parseArgs(args: readonly string[]): ParsedArgs {
  let profile: string | undefined;
  let update = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--update") {
      update = true;
      continue;
    }
    if (arg === "--profile") {
      if (profile !== undefined) {
        return { kind: "error", message: `${USAGE}\n--profile may be provided only once` };
      }
      const value = args[index + 1];
      if (value === undefined) {
        return { kind: "error", message: `${USAGE}\n--profile requires a value` };
      }
      profile = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    return { kind: "error", message: `${USAGE}\nUnknown argument: ${arg}` };
  }

  return { kind: "run", options: { profile, update } };
}

function finishSync(runtime: Runtime, options: SyncOptions, cliVersion: string): number {
  if (options.update) {
    const status = updateGlobalSkills(runtime, cliVersion);
    if (status !== 0) {
      return status;
    }
  }

  writeLine(runtime.stdout, "Done.");
  return 0;
}

function sync(runtime: Runtime, options: SyncOptions): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const home = runtime.env.HOME;
  if (!home) {
    throw new Error("HOME is required to manage agent skills");
  }

  const cliVersion = runtime.env.SKILLS_CLI_VERSION || DEFAULT_SKILLS_CLI_VERSION;

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { layers, skills, localPath, localNames } = readLayeredSkills(
    repoDir,
    profileName,
    profile.agentLayers,
  );
  const skillLockPath = managedLockPath(runtime.env, repoDir, "skills");
  const previouslyManagedSkills = readSkillLock(skillLockPath);
  const overlay = guardOverlay(readOverlayOwnership(skillLockPath), repoDir, localNames);
  const agents = findInstalledAgents(runtime);

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `Skill layers: ${layers.join(", ")}`);
  if (localPath) writeLine(runtime.stdout, `Local overlay: ${localPath}`);
  if (agents.length === 0) {
    writeLine(
      runtime.stdout,
      "No supported agent installations found; skipping skill installation",
    );
  } else {
    writeLine(runtime.stdout, `Installing skills for agents: ${agents.join(" ")}`);
    const status = installSkills(runtime, skills, agents, cliVersion, home);
    if (status !== 0) {
      return status;
    }
  }

  const currentNames = new Set(skills.map((skill) => skill.name));
  if (previouslyManagedSkills === undefined) {
    if (agents.length === 0) {
      writeLine(runtime.stdout, "No managed skills lock found; skipping ownership initialization");
      return finishSync(runtime, options, cliVersion);
    }
    writeLine(runtime.stdout, "Initializing managed skills lock without removing existing skills");
  } else {
    const staleSkills = previouslyManagedSkills.filter(
      (skill) => !currentNames.has(skill.name) && !overlay.kept.has(skill.name),
    );
    const removalStatus = removeSkills(runtime, staleSkills, cliVersion, home);
    if (removalStatus !== 0) {
      return removalStatus;
    }
  }

  const managedSkills = [
    ...(agents.length === 0 && previouslyManagedSkills !== undefined
      ? previouslyManagedSkills.filter((skill) => currentNames.has(skill.name))
      : skills),
    ...(previouslyManagedSkills ?? []).filter(
      (skill) => !currentNames.has(skill.name) && overlay.kept.has(skill.name),
    ),
  ];
  writeSkillLock(skillLockPath, managedSkills, overlay.next);

  return finishSync(runtime, options, cliVersion);
}

export function main(args: readonly string[], runtime: Runtime = createRuntime()): number {
  const parsed = parseArgs(args);
  if (parsed.kind === "help") {
    writeLine(runtime.stdout, USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    writeLine(runtime.stderr, parsed.message);
    return 2;
  }

  try {
    return sync(runtime, parsed.options);
  } catch (error) {
    writeLine(runtime.stderr, `Sync failed: ${errorMessage(error)}`);
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
