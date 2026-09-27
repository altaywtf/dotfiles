import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { AgentLayer } from "../../profiles/model.ts";
import { composeLayers } from "../harness.ts";
import { readLocalOverlay } from "../local.ts";
import { readLockFile } from "../lock.ts";
import { errorMessage } from "../runtime.ts";

const Skill = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  source: Schema.NonEmptyString,
});
export type Skill = typeof Skill.Type;

function parseSkills(value: unknown, label: string): Skill[] {
  if (!Array.isArray(value) || !value.every(Schema.is(Skill))) {
    throw new Error(`${label}: expected non-empty name/source strings`);
  }

  const names = value.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${label}: skill names must be unique`);
  }

  // Layer composition compares entry shapes, so authoring key order must not matter.
  return value.map(({ name, source }) => ({ name, source }));
}

function readSkills(manifestPath: string): Skill[] {
  const label = `Invalid skills manifest at ${manifestPath}`;
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${label}: ${errorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || !("skills" in parsed)) {
    throw new Error(`${label}: expected non-empty name/source strings`);
  }
  return parseSkills(parsed.skills, label);
}

export type SkillLayer = AgentLayer | "local";

export function readLayeredSkills(
  repoDir: string,
  profile: string,
  layers: readonly AgentLayer[],
): { layers: readonly SkillLayer[]; skills: Skill[]; localPath?: string; localNames?: string[] } {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent skills`);
  }

  const manifests = new Map<SkillLayer, Skill[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    const manifestPath = join(repoDir, "agents", "skills", `${layer}.json`);
    manifests.set(layer, readSkills(manifestPath));
  }

  const selected: SkillLayer[] = [...layers];
  const local = readLocalOverlay(repoDir);
  if (local?.document.skills !== undefined) {
    manifests.set(
      "local",
      parseSkills(local.document.skills, `Invalid local agent overlay at ${local.path}`),
    );
    selected.push("local");
  }

  const skills = composeLayers(
    selected,
    manifests,
    (skill) => skill.name,
    (name) => {
      const sources = selected
        .flatMap((layer) => manifests.get(layer) ?? [])
        .filter((skill) => skill.name === name)
        .map((skill) => skill.source);
      return `Invalid layered skills: ${name} is defined more than once (${sources.join(" and ")})`;
    },
  );

  return selected.includes("local") && local
    ? {
        layers: selected,
        skills,
        localPath: local.path,
        localNames: (manifests.get("local") ?? []).map((skill) => skill.name),
      }
    : { layers: selected, skills };
}

export function readSkillLock(lockPath: string): Skill[] | undefined {
  const parsed = readLockFile(lockPath, "skills");
  if (parsed === undefined) {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("skills" in parsed) ||
    !Array.isArray(parsed.skills) ||
    !parsed.skills.every(Schema.is(Skill))
  ) {
    throw new Error(
      `Invalid managed skills lock at ${lockPath}: expected version 1 and safe name/source entries`,
    );
  }

  const names = parsed.skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid managed skills lock at ${lockPath}: skill names must be unique`);
  }

  return parsed.skills;
}
