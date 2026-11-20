import { join } from "node:path";
import { Schema } from "effect";
import type { AgentLayer } from "../../profiles/model.ts";
import { decodeOr, readJsonFile } from "../decode.ts";
import { composeLayers } from "../harness.ts";
import { readLocalOverlay } from "../local.ts";
import { readLockFile } from "../lock.ts";

const Skill = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  source: Schema.NonEmptyString,
});
export type Skill = typeof Skill.Type;

const SkillManifest = Schema.Struct({ skills: Schema.Unknown });

const SkillLock = Schema.Struct({ version: Schema.Literal(1), skills: Schema.Array(Skill) });

function parseSkills(value: unknown, label: string): ReadonlyArray<Skill> {
  const skills = decodeOr(
    Schema.Array(Skill),
    value,
    `${label}: expected non-empty name/source strings`,
  );

  const names = skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`${label}: skill names must be unique`);
  }
  return skills;
}

// Tracked manifests name a GitHub owner/repository or an HTTPS URL; the local
// overlay may use any source the skills CLI accepts.
const MANIFEST_SOURCE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+|https:\/\/\S+)$/;

function readSkills(manifestPath: string): ReadonlyArray<Skill> {
  const label = `Invalid skills manifest at ${manifestPath}`;
  const manifest = decodeOr(
    SkillManifest,
    readJsonFile(manifestPath, label),
    `${label}: expected non-empty name/source strings`,
  );
  const skills = parseSkills(manifest.skills, label);
  const invalid = skills.find((skill) => !MANIFEST_SOURCE.test(skill.source));
  if (invalid !== undefined) {
    throw new Error(`${label}: ${invalid.name} source must be owner/repository or an HTTPS URL`);
  }
  return skills;
}

export type SkillLayer = AgentLayer | "local";

export function readLayeredSkills(
  repoDir: string,
  profile: string,
  layers: ReadonlyArray<AgentLayer>,
): {
  layers: ReadonlyArray<SkillLayer>;
  skills: Array<Skill>;
  localPath?: string;
  localNames?: Array<string>;
} {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage agent skills`);
  }

  const manifests = new Map<SkillLayer, ReadonlyArray<Skill>>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    const manifestPath = join(repoDir, "agents", "skills", `${layer}.json`);
    manifests.set(layer, readSkills(manifestPath));
  }

  const selected: Array<SkillLayer> = [...layers];
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
        .flatMap((skill) => (skill.name === name ? [skill.source] : []));
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

export function readSkillLock(lockPath: string): ReadonlyArray<Skill> | undefined {
  const parsed = readLockFile(lockPath, "skills");
  if (parsed === undefined) {
    return undefined;
  }

  const { skills } = decodeOr(
    SkillLock,
    parsed,
    `Invalid managed skills lock at ${lockPath}: expected version 1 and safe name/source entries`,
  );

  const names = skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid managed skills lock at ${lockPath}: skill names must be unique`);
  }

  return skills;
}
