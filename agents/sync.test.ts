import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import { readProfileModel } from "../profiles/model.ts";
import { DEFAULT_SKILLS_CLI_VERSION, main, type Runtime } from "./sync.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileModel = readProfileModel(join(repoRoot, "chezmoi/.chezmoidata/profiles.json"));

type CommandCall = {
  command: string;
  args: readonly string[];
};

type FixtureOptions = {
  falseSuccesses?: ReadonlySet<string>;
  failures?: ReadonlyMap<string, FixtureFailure>;
  profile?: string;
  removalFailures?: ReadonlyMap<string, FixtureFailure>;
  updateFailure?: FixtureFailure;
};

type FixtureFailure = {
  stderr: string;
  stdout: string;
};

class BufferWriter {
  value = "";

  write(message: string): void {
    this.value += message;
  }
}

class FixtureRuntime implements Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout = new BufferWriter();
  readonly stderr = new BufferWriter();
  readonly calls: CommandCall[] = [];
  readonly installedCommands = new Set(["claude", "codex"]);
  readonly falseSuccesses: ReadonlySet<string>;
  readonly failures: ReadonlyMap<string, FixtureFailure>;
  readonly home: string;
  readonly profile: string;
  readonly repoDir: string;
  readonly removalFailures: ReadonlyMap<string, FixtureFailure>;
  readonly updateFailure: FixtureFailure | undefined;

  constructor(repoDir: string, home: string, options: FixtureOptions = {}) {
    this.repoDir = repoDir;
    this.removalFailures = options.removalFailures ?? new Map();
    this.falseSuccesses = options.falseSuccesses ?? new Set();
    this.failures = options.failures ?? new Map();
    this.home = home;
    this.profile = options.profile ?? "workstation";
    this.updateFailure = options.updateFailure;
    this.env = { HOME: home, SKILLS_CLI_VERSION: "test-version" };
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(
    command: string,
    args: readonly string[],
  ): { status: number; stdout: string; stderr: string } {
    this.calls.push({ command, args });

    if (command.endsWith("/resolve-profile.ts")) {
      const expectedFlag = args.indexOf("--expected");
      const expected = expectedFlag >= 0 ? args[expectedFlag + 1] : undefined;
      if (expected !== undefined && expected !== this.profile) {
        return { status: 3, stdout: "", stderr: "profile mismatch" };
      }
      if (!Object.hasOwn(profileModel.profiles, this.profile)) {
        return { status: 3, stdout: "", stderr: "unknown profile" };
      }
      return { status: 0, stdout: `${this.profile}\n`, stderr: "" };
    }

    if (command === "pnpm" && args[0] === "dlx" && args[2] === "add") {
      const skillFlag = args.indexOf("-s");
      const skill = skillFlag >= 0 ? args[skillFlag + 1] : undefined;
      if (skill === undefined) {
        throw new Error("skills installer call must include -s <name>");
      }
      const diagnostic = this.failures.get(skill);
      if (diagnostic !== undefined) {
        return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
      }
      if (!this.falseSuccesses.has(skill)) {
        const skillDir = join(this.home, ".agents", "skills", skill);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, "SKILL.md"),
          `---\nname: ${skill}\ndescription: Fixture\n---\n`,
        );
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "pnpm" && args[0] === "dlx" && args[2] === "remove") {
      const skill = args[3];
      if (skill === undefined) {
        throw new Error("skills remover call must include a skill name");
      }
      const diagnostic = this.removalFailures.get(skill);
      if (diagnostic !== undefined) {
        return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
      }
      rmSync(join(this.home, ".agents", "skills", skill), { force: true, recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "pnpm" && args[0] === "dlx" && args[2] === "update") {
      if (this.updateFailure !== undefined) {
        return {
          status: 1,
          stdout: this.updateFailure.stdout,
          stderr: this.updateFailure.stderr,
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }

    return { status: 99, stdout: "", stderr: `Unexpected command: ${command}` };
  }
}

const temporaryDirectories: string[] = [];

const fixtureSkills = [
  { name: "ok-before", source: "fixture/before" },
  { name: "fails-first", source: "fixture/failure-first" },
  { name: "ok-middle", source: "fixture/middle" },
  { name: "fails-second", source: "fixture/failure-second" },
  { name: "ok-after", source: "fixture/after" },
];

const fixturePersonalSkills = [{ name: "personal-only", source: "fixture/personal" }];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-sync-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");

  mkdirSync(join(repoDir, "agents", "skills"), { recursive: true });
  mkdirSync(join(repoDir, "chezmoi", ".chezmoidata"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi", ".chezmoidata", "profiles.json"),
    readFileSync(join(repoRoot, "chezmoi", ".chezmoidata", "profiles.json")),
  );
  writeFileSync(
    join(repoDir, "agents", "skills", "developer.json"),
    JSON.stringify({ skills: fixtureSkills }, null, 2),
  );
  writeFileSync(
    join(repoDir, "agents", "skills", "personal.json"),
    JSON.stringify({ skills: fixturePersonalSkills }, null, 2),
  );
  for (const axis of ["workstation", "devbox"]) {
    writeFileSync(
      join(repoDir, "agents", "skills", `${axis}.json`),
      JSON.stringify({ skills: [] }, null, 2),
    );
  }
  mkdirSync(dirname(skillLockPath(home)), { recursive: true });
  writeFileSync(
    skillLockPath(home),
    JSON.stringify({ version: 1, skills: fixtureSkills }, null, 2),
  );

  return { repoDir, home };
}

function installedSkillNames(runtime: FixtureRuntime): string[] {
  return runtime.calls
    .filter((call) => call.command === "pnpm" && call.args[0] === "dlx" && call.args[2] === "add")
    .map((call) => {
      const skillFlag = call.args.indexOf("-s");
      const skill = skillFlag >= 0 ? call.args[skillFlag + 1] : undefined;
      if (skill === undefined) {
        throw new Error("recorded skills installer call must include -s <name>");
      }
      return skill;
    });
}

function removedSkillNames(runtime: FixtureRuntime): string[] {
  return runtime.calls
    .filter(
      (call) => call.command === "pnpm" && call.args[0] === "dlx" && call.args[2] === "remove",
    )
    .map((call) => {
      const skill = call.args[3];
      if (skill === undefined) {
        throw new Error("recorded skills remover call must include a skill name");
      }
      return skill;
    });
}

function updateCalls(runtime: FixtureRuntime): CommandCall[] {
  return runtime.calls.filter(
    (call) => call.command === "pnpm" && call.args[0] === "dlx" && call.args[2] === "update",
  );
}

function skillLockPath(home: string): string {
  return join(home, ".local/state/dotfiles/agents", "skills.lock.json");
}

test("reports every installer failure after attempting the full manifest", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "fails-first",
        {
          stdout: "installer token=stdout-secret",
          stderr: "npm error code E401\nnpm error token=stderr-secret",
        },
      ],
      ["fails-second", { stdout: "", stderr: "package source was not found" }],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(installedSkillNames(runtime), [
    "ok-before",
    "fails-first",
    "ok-middle",
    "fails-second",
    "ok-after",
  ]);
  assert.match(runtime.stderr.value, /Skill installation failed for 2 skills:/);
  assert.match(runtime.stderr.value, /fails-first \(fixture\/failure-first, exit 1\)/);
  assert.match(runtime.stderr.value, /fails-second \(fixture\/failure-second, exit 1\)/);
  assert.match(runtime.stderr.value, /installer token=\[REDACTED\]/);
  assert.match(runtime.stderr.value, /npm error token=\[REDACTED\]/);
  assert.match(runtime.stderr.value, /package source was not found/);
  assert.doesNotMatch(runtime.stderr.value, /stdout-secret|stderr-secret/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("rejects a false-success installer result when the installed artifact is missing", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    falseSuccesses: new Set(["ok-middle"]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(installedSkillNames(runtime), [
    "ok-before",
    "fails-first",
    "ok-middle",
    "fails-second",
    "ok-after",
  ]);
  assert.match(runtime.stderr.value, /ok-middle \(fixture\/middle, invalid installed artifact\)/);
  assert.match(runtime.stderr.value, /installer reported success but .*SKILL\.md is missing/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("completes a successful skill sync without Git or rule changes", () => {
  const { repoDir, home } = createFixture();
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "existing Claude rules\n");
  writeFileSync(join(home, ".codex", "AGENTS.md"), "existing Codex rules\n");
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.env.SKILLS_CLI_VERSION = "";

  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /Done\./);
  assert.equal(
    runtime.calls.find((call) => call.command === "pnpm" && call.args[0] === "dlx")?.args[1],
    `skills@${DEFAULT_SKILLS_CLI_VERSION}`,
  );
  assert.equal(
    runtime.calls.some((call) => call.command === "git"),
    false,
  );
  assert.equal(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), "existing Claude rules\n");
  assert.equal(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8"), "existing Codex rules\n");
});

test("installs the personal layer only for personal profiles", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-devbox" });

  assert.equal(main(["--profile", "personal-devbox"], runtime), 0);
  assert.deepEqual(
    installedSkillNames(runtime),
    [...fixtureSkills, ...fixturePersonalSkills].map((skill) => skill.name),
  );
  assert.match(runtime.stdout.value, /Profile: personal-devbox/);
  assert.match(runtime.stdout.value, /Skill layers: developer, devbox, personal/);
});

test("rejects duplicate names across selected layers before installing skills", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    join(repoDir, "agents", "skills", "personal.json"),
    JSON.stringify({ skills: [{ name: fixtureSkills[0]?.name, source: "fixture/conflict" }] }),
  );
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-workstation" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Invalid layered skills/);
  assert.equal(installedSkillNames(runtime).length, 0);
});

test("refuses an unknown profile before managing skills", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "unsupported" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Profile resolution failed/);
  assert.equal(runtime.calls.length, 1);
  assert.ok(runtime.calls[0]?.command.endsWith("/resolve-profile.ts"));
});

test("initializes a missing ownership lock without removing unowned skills", () => {
  const { repoDir, home } = createFixture();
  rmSync(skillLockPath(home));
  const unownedSkill = join(home, ".agents", "skills", "manual-skill");
  mkdirSync(unownedSkill, { recursive: true });
  writeFileSync(join(unownedSkill, "SKILL.md"), "manual skill\n");
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(removedSkillNames(runtime), []);
  assert.equal(existsSync(unownedSkill), true);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(home), "utf8")), {
    version: 1,
    skills: fixtureSkills,
  });
  assert.match(
    runtime.stdout.value,
    /Initializing managed skills lock without removing existing skills/,
  );
});

test("removes only skills dropped from the previous managed lock", () => {
  const { repoDir, home } = createFixture();
  const retiredSkill = { name: "retired-managed", source: "fixture/retired" };
  writeFileSync(
    skillLockPath(home),
    JSON.stringify({ version: 1, skills: [...fixtureSkills, retiredSkill] }, null, 2),
  );
  const retiredDirectory = join(home, ".agents", "skills", retiredSkill.name);
  const unownedDirectory = join(home, ".agents", "skills", "manual-skill");
  mkdirSync(retiredDirectory, { recursive: true });
  mkdirSync(unownedDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(removedSkillNames(runtime), [retiredSkill.name]);
  const removalCall = runtime.calls.find(
    (call) => call.command === "pnpm" && call.args[2] === "remove",
  );
  assert.deepEqual(removalCall?.args, [
    "dlx",
    "skills@test-version",
    "remove",
    retiredSkill.name,
    "-g",
    "-y",
  ]);
  assert.equal(existsSync(retiredDirectory), false);
  assert.equal(existsSync(unownedDirectory), true);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(home), "utf8")), {
    version: 1,
    skills: fixtureSkills,
  });
});

test("removes stale managed skills when no supported agent is installed", () => {
  const { repoDir, home } = createFixture();
  const retiredSkill = { name: "retired-managed", source: "fixture/retired" };
  writeFileSync(
    skillLockPath(home),
    JSON.stringify({ version: 1, skills: [...fixtureSkills, retiredSkill] }, null, 2),
  );
  const retiredDirectory = join(home, ".agents", "skills", retiredSkill.name);
  const unownedDirectory = join(home, ".agents", "skills", "manual-skill");
  mkdirSync(retiredDirectory, { recursive: true });
  mkdirSync(unownedDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home);
  runtime.installedCommands.clear();

  assert.equal(main([], runtime), 0);
  assert.deepEqual(installedSkillNames(runtime), []);
  assert.deepEqual(removedSkillNames(runtime), [retiredSkill.name]);
  assert.equal(existsSync(retiredDirectory), false);
  assert.equal(existsSync(unownedDirectory), true);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(home), "utf8")), {
    version: 1,
    skills: fixtureSkills,
  });
  assert.match(runtime.stdout.value, /skipping skill installation/);
});

test("does not prune or advance ownership when installation fails", () => {
  const { repoDir, home } = createFixture();
  const retiredSkill = { name: "retired-managed", source: "fixture/retired" };
  const previousLock = { version: 1, skills: [...fixtureSkills, retiredSkill] };
  writeFileSync(skillLockPath(home), JSON.stringify(previousLock, null, 2));
  const retiredDirectory = join(home, ".agents", "skills", retiredSkill.name);
  mkdirSync(retiredDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([["fails-first", { stdout: "", stderr: "install failed" }]]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(removedSkillNames(runtime), []);
  assert.equal(existsSync(retiredDirectory), true);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(home), "utf8")), previousLock);
});

test("does not advance ownership when a managed removal fails", () => {
  const { repoDir, home } = createFixture();
  const retiredSkill = { name: "retired-managed", source: "fixture/retired" };
  const previousLock = { version: 1, skills: [...fixtureSkills, retiredSkill] };
  writeFileSync(skillLockPath(home), JSON.stringify(previousLock, null, 2));
  const retiredDirectory = join(home, ".agents", "skills", retiredSkill.name);
  mkdirSync(retiredDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home, {
    removalFailures: new Map([[retiredSkill.name, { stdout: "", stderr: "remove failed" }]]),
  });

  assert.equal(main([], runtime), 1);
  assert.deepEqual(removedSkillNames(runtime), [retiredSkill.name]);
  assert.equal(existsSync(retiredDirectory), true);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(home), "utf8")), previousLock);
  assert.match(runtime.stderr.value, /Managed skill removal failed for 1 skill/);
});

test("rejects unsafe ownership lock names before changing skills", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    skillLockPath(home),
    JSON.stringify({ version: 1, skills: [{ name: "../manual-skill", source: "fixture/unsafe" }] }),
  );
  const manualDirectory = join(home, ".agents", "manual-skill");
  mkdirSync(manualDirectory, { recursive: true });
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Invalid managed skills lock/);
  assert.equal(installedSkillNames(runtime).length, 0);
  assert.equal(removedSkillNames(runtime).length, 0);
  assert.equal(existsSync(manualDirectory), true);
});

test("rejects an invalid manifest before changing skills", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    join(repoDir, "agents", "skills", "developer.json"),
    '{"skills":[{"name":"missing-source"}]}',
  );
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Invalid skills manifest/);
  assert.match(runtime.stderr.value, /expected non-empty name\/source strings/);
  assert.equal(installedSkillNames(runtime).length, 0);
});

test("rejects unknown sync arguments without changing state", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main(["--refresh"], runtime), 2);
  assert.match(
    runtime.stderr.value,
    /Usage: \.\/agents\/sync\.ts \[--profile PROFILE\] \[--update\]/,
  );
  assert.match(runtime.stderr.value, /Unknown argument: --refresh/);
  assert.equal(runtime.calls.length, 0);
});

test("prints help without syncing", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main(["--help"], runtime), 0);
  assert.match(
    runtime.stdout.value,
    /Usage: \.\/agents\/sync\.ts \[--profile PROFILE\] \[--update\]/,
  );
  assert.equal(runtime.calls.length, 0);
});

test("does not run the global updater unless --update is passed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.equal(updateCalls(runtime).length, 0);
  assert.match(runtime.stdout.value, /Done\./);
});

test("runs skills update -g after a successful sync when --update is passed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main(["--update"], runtime), 0);
  assert.deepEqual(
    updateCalls(runtime).map((call) => call.args),
    [["dlx", "skills@test-version", "update", "-g", "-y"]],
  );
  assert.match(runtime.stdout.value, /Updating globally installed skills\.\.\./);
  assert.match(runtime.stdout.value, /Done\./);
  assert.equal(installedSkillNames(runtime).length, fixtureSkills.length);
});

test("reports updater failure after the managed sync already completed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    updateFailure: { stdout: "", stderr: "rate limited" },
  });

  assert.equal(main(["--update"], runtime), 1);
  assert.equal(updateCalls(runtime).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(skillLockPath(home), "utf8")), {
    version: 1,
    skills: fixtureSkills,
  });
  assert.match(runtime.stderr.value, /Global skill update failed \(exit 1\)/);
  assert.match(runtime.stderr.value, /Manifest sync already completed/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("skips the updater when managed skill installation fails", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([["fails-first", { stdout: "", stderr: "boom" }]]),
  });

  assert.equal(main(["--update"], runtime), 1);
  assert.equal(updateCalls(runtime).length, 0);
  assert.match(runtime.stderr.value, /Skill installation failed for 1 skill/);
});

test("the executable TypeScript entrypoint runs the CLI", () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "sync.ts");
  const result = spawnSync(scriptPath, ["unexpected"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: \.\/agents\/sync\.ts \[--profile PROFILE\] \[--update\]/);
  assert.match(result.stderr, /Unknown argument: unexpected/);
});

test("ownership survives the deletion of the checkout that provisioned it", () => {
  const { repoDir, home } = createFixture();
  rmSync(skillLockPath(home));
  const manualSkill = join(home, ".agents", "skills", "manual-skill");
  mkdirSync(manualSkill, { recursive: true });
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  rmSync(repoDir, { recursive: true });

  const fresh = createFixture().repoDir;
  writeFileSync(
    join(fresh, "agents", "skills", "developer.json"),
    JSON.stringify({ skills: fixtureSkills.filter((skill) => skill.name !== "ok-after") }),
  );
  const runtime = new FixtureRuntime(fresh, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(removedSkillNames(runtime), ["ok-after"]);
  assert.ok(existsSync(manualSkill));
});

test("another checkout without the overlay keeps overlay-owned skills", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    join(repoDir, "agents", "local.json"),
    JSON.stringify({ skills: [{ name: "machine-only", source: "fixture/machine" }] }),
    { mode: 0o600 },
  );
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);

  const other = new FixtureRuntime(createFixture().repoDir, home);
  assert.equal(main([], other), 0);
  assert.deepEqual(removedSkillNames(other), []);

  rmSync(join(repoDir, "agents", "local.json"));
  const owner = new FixtureRuntime(repoDir, home);
  assert.equal(main([], owner), 0);
  assert.deepEqual(removedSkillNames(owner), ["machine-only"]);
});

test("checkouts with their own overlays keep each other's skills", () => {
  const first = createFixture();
  const second = createFixture().repoDir;
  const overlay = (repoDir: string, name: string) =>
    writeFileSync(
      join(repoDir, "agents", "local.json"),
      JSON.stringify({ skills: [{ name, source: `fixture/${name}` }] }),
      { mode: 0o600 },
    );
  overlay(first.repoDir, "first-only");
  overlay(second, "second-only");
  assert.equal(main([], new FixtureRuntime(first.repoDir, first.home)), 0);

  const runtime = new FixtureRuntime(second, first.home);
  assert.equal(main([], runtime), 0);
  assert.deepEqual(removedSkillNames(runtime), []);
});
