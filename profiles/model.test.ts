import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import { parseProfileModel, readProfileModel, requireProfile } from "./model.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = join(repoRoot, "chezmoi/.chezmoidata/profiles.json");
const sourceDir = join(repoRoot, "chezmoi");
const profileNames = [
  "devbox",
  "developer",
  "personal-devbox",
  "personal-workstation",
  "workstation",
];

function rawModel(): {
  profileModel: Record<string, unknown> & { profiles: Record<string, Record<string, unknown>> };
} {
  return JSON.parse(readFileSync(modelPath, "utf8"));
}

function renderProfile(profile: string, profileModel?: unknown): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-profile-render-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "tmp"));
  const override =
    profileModel === undefined
      ? { dotfilesProfile: profile }
      : { dotfilesProfile: profile, profileModel };
  const result = spawnSync(
    "chezmoi",
    [
      "--source",
      sourceDir,
      "--override-data",
      JSON.stringify(override),
      "execute-template",
      '{{ includeTemplate "profile" . }}',
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "xdg/config"),
        XDG_CACHE_HOME: join(root, "xdg/cache"),
        TMPDIR: join(root, "tmp"),
        NO_COLOR: "1",
      },
    },
  );
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("canonical model covers every profile and renders through chezmoi", () => {
  const model = readProfileModel(modelPath);
  assert.deepEqual(Object.keys(model.profiles).sort(), profileNames);
  for (const profile of profileNames) {
    const result = renderProfile(profile);
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(JSON.parse(String(result.stdout)), model.profiles[profile]);
  }
});

test("TypeScript rejects malformed, unsupported, missing, and wrong-type data", () => {
  assert.throws(() => parseProfileModel('{"profileModel":'), /not valid JSON/);

  const unsupported = rawModel();
  unsupported.profileModel.version = 2;
  assert.throws(() => parseProfileModel(JSON.stringify(unsupported)), /Expected 1/);

  const missing = rawModel();
  const capabilities = missing.profileModel.profiles.workstation.capabilities as Record<
    string,
    unknown
  >;
  delete capabilities.devbox;
  assert.throws(() => parseProfileModel(JSON.stringify(missing)), /Missing key/);

  const wrongType = rawModel();
  (wrongType.profileModel.profiles.workstation.capabilities as Record<string, unknown>).devbox =
    "yes";
  assert.throws(() => parseProfileModel(JSON.stringify(wrongType)), /Expected boolean/);

  const leftoverRuntimeGroup = rawModel();
  leftoverRuntimeGroup.profileModel.profiles.workstation.runtimeGroup = "developer";
  assert.throws(
    () => parseProfileModel(JSON.stringify(leftoverRuntimeGroup)),
    /Expected no excess property/,
  );

  const leftoverDeveloper = rawModel();
  (
    leftoverDeveloper.profileModel.profiles.workstation.capabilities as Record<string, unknown>
  ).developer = true;
  assert.throws(
    () => parseProfileModel(JSON.stringify(leftoverDeveloper)),
    /Expected no excess property/,
  );

  const missingRuntimeStep = rawModel();
  missingRuntimeStep.profileModel.profiles.workstation.installSteps = [
    "apply-dotfiles",
    "trust-agent-worktrees",
    "configure-codex",
  ];
  assert.throws(() => parseProfileModel(JSON.stringify(missingRuntimeStep)), /install-runtimes/);

  const emptyAgentLayers = rawModel();
  emptyAgentLayers.profileModel.profiles.workstation.agentLayers = [];
  assert.throws(
    () => parseProfileModel(JSON.stringify(emptyAgentLayers)),
    /must include developer/,
  );

  const model = readProfileModel(modelPath);
  assert.throws(() => requireProfile(model, "unknown"), /unknown profile/);
  assert.throws(() => requireProfile(model, "constructor"), /unknown profile/);
});

test("both consumers reject duplicate and incomplete agent layers", () => {
  for (const agentLayers of [["developer", "developer"], ["workstation"]]) {
    const model = rawModel();
    model.profileModel.profiles.workstation.agentLayers = agentLayers;
    assert.throws(() => parseProfileModel(JSON.stringify(model)));
    assert.notEqual(renderProfile("workstation", model.profileModel).status, 0);
  }
});

test("profile validation rejects an unknown installation step before execution", () => {
  const model = rawModel();
  model.profileModel.profiles.developer.installSteps = [
    "apply-dotfiles",
    "install-runtimes",
    "install-repository-dependencies",
    "not-a-real-step",
  ];
  assert.throws(() => parseProfileModel(JSON.stringify(model)), /\["installSteps"\]\[3\]/);
});

test("external Homebrew declarations reject malformed entries in both consumers", () => {
  for (const externalHomebrew of [
    null,
    "slopguard",
    ["slopguard"],
    [{ packageType: "tap", name: "example/tap" }],
    [{ packageType: "cask", name: "" }],
    [{ packageType: "cask", name: "example", extra: true }],
  ]) {
    const model = rawModel();
    model.profileModel.profiles.workstation.externalHomebrew = externalHomebrew;
    assert.throws(() => parseProfileModel(JSON.stringify(model)));
    assert.notEqual(renderProfile("workstation", model.profileModel).status, 0);
  }
});

test("chezmoi rejects unsupported, unknown, missing, and wrong-type data", () => {
  const unsupported = rawModel();
  unsupported.profileModel.version = 2;
  assert.notEqual(renderProfile("workstation", unsupported.profileModel).status, 0);
  assert.notEqual(renderProfile("unknown").status, 0);

  const missing = rawModel();
  delete (missing.profileModel.profiles.workstation.capabilities as Record<string, unknown>).devbox;
  assert.notEqual(renderProfile("workstation", missing.profileModel).status, 0);

  const wrongType = rawModel();
  (wrongType.profileModel.profiles.workstation.capabilities as Record<string, unknown>).devbox =
    "yes";
  assert.notEqual(renderProfile("workstation", wrongType.profileModel).status, 0);

  const leftoverRuntimeGroup = rawModel();
  leftoverRuntimeGroup.profileModel.profiles.workstation.runtimeGroup = "developer";
  assert.notEqual(renderProfile("workstation", leftoverRuntimeGroup.profileModel).status, 0);

  const leftoverDeveloper = rawModel();
  (
    leftoverDeveloper.profileModel.profiles.workstation.capabilities as Record<string, unknown>
  ).developer = true;
  assert.notEqual(renderProfile("workstation", leftoverDeveloper.profileModel).status, 0);

  const missingRuntimeStep = rawModel();
  missingRuntimeStep.profileModel.profiles.workstation.installSteps = [
    "apply-dotfiles",
    "trust-agent-worktrees",
    "configure-codex",
  ];
  assert.notEqual(renderProfile("workstation", missingRuntimeStep.profileModel).status, 0);

  const emptyAgentLayers = rawModel();
  emptyAgentLayers.profileModel.profiles.workstation.agentLayers = [];
  assert.notEqual(renderProfile("workstation", emptyAgentLayers.profileModel).status, 0);
});

test("chezmoi rejects malformed profile data before rendering", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-profile-syntax-"));
  try {
    mkdirSync(join(root, ".chezmoidata"), { recursive: true });
    mkdirSync(join(root, ".chezmoitemplates"), { recursive: true });
    mkdirSync(join(root, "home"));
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(root, ".chezmoidata/profiles.json"), '{"profileModel":');
    writeFileSync(
      join(root, ".chezmoitemplates/profile"),
      readFileSync(join(sourceDir, ".chezmoitemplates/profile")),
    );
    const result = spawnSync(
      "chezmoi",
      [
        "--source",
        root,
        "--override-data",
        '{"dotfilesProfile":"workstation"}',
        "execute-template",
        '{{ includeTemplate "profile" . }}',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "xdg/config"),
          XDG_CACHE_HOME: join(root, "xdg/cache"),
          TMPDIR: join(root, "tmp"),
          NO_COLOR: "1",
        },
      },
    );
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
