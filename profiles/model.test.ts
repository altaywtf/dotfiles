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

type RawModel = Record<string, unknown> & { profiles: Record<string, Record<string, unknown>> };

function rawModel(): RawModel {
  return JSON.parse(readFileSync(modelPath, "utf8")).profileModel;
}

// Chezmoi reads the model from a data file, as in production; --override-data
// would turn every number into a float and fail the version check for any model.
function renderProfile(profile: string, profileData?: string) {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-profile-render-"));
  let source = sourceDir;
  if (profileData !== undefined) {
    source = join(root, "source");
    mkdirSync(join(source, ".chezmoidata"), { recursive: true });
    mkdirSync(join(source, ".chezmoitemplates"));
    writeFileSync(join(source, ".chezmoidata/profiles.json"), profileData);
    writeFileSync(
      join(source, ".chezmoitemplates/profile"),
      readFileSync(join(sourceDir, ".chezmoitemplates/profile")),
    );
  }
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "tmp"));
  const result = spawnSync(
    "chezmoi",
    [
      "--source",
      source,
      "--override-data",
      JSON.stringify({ dotfilesProfile: profile }),
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
  const copied = renderProfile("workstation", JSON.stringify({ profileModel: rawModel() }));
  assert.equal(copied.status, 0, copied.stderr);
});

const workstation = (model: RawModel) => model.profiles.workstation;
const capabilities = (model: RawModel) =>
  workstation(model).capabilities as Record<string, unknown>;
const invalidModels: Array<[string, (model: RawModel) => void, RegExp?]> = [
  ["unsupported version", (model) => (model.version = 2), /Expected 1/],
  ["missing key", (model) => delete capabilities(model).devbox, /Missing key/],
  ["wrong type", (model) => (capabilities(model).devbox = "yes"), /Expected boolean/],
  [
    "leftover runtimeGroup",
    (model) => (workstation(model).runtimeGroup = "developer"),
    /Expected no excess property/,
  ],
  [
    "leftover developer capability",
    (model) => (capabilities(model).developer = true),
    /Expected no excess property/,
  ],
  [
    "missing runtime step",
    (model) =>
      (workstation(model).installSteps = [
        "apply-dotfiles",
        "trust-agent-worktrees",
        "configure-codex",
      ]),
    /install-runtimes/,
  ],
  [
    "empty agent layers",
    (model) => (workstation(model).agentLayers = []),
    /must include developer/,
  ],
  [
    "duplicate agent layers",
    (model) => (workstation(model).agentLayers = ["developer", "developer"]),
  ],
  ["agent layers without developer", (model) => (workstation(model).agentLayers = ["workstation"])],
  ...(
    [
      null,
      "example",
      ["example"],
      [{ packageType: "tap", name: "example/tap" }],
      [{ packageType: "cask", name: "" }],
      [{ packageType: "cask", name: "example", extra: true }],
    ] as const
  ).map((externalHomebrew): [string, (model: RawModel) => void] => [
    `external Homebrew ${JSON.stringify(externalHomebrew)}`,
    (model) => (workstation(model).externalHomebrew = externalHomebrew),
  ]),
];

test.each(invalidModels)(
  "TypeScript and chezmoi both reject %s",
  (_name, mutate, message = /./) => {
    const model = rawModel();
    mutate(model);
    assert.throws(() => parseProfileModel(JSON.stringify({ profileModel: model })), message);
    const rendered = renderProfile("workstation", JSON.stringify({ profileModel: model }));
    assert.notEqual(rendered.status, 0);
    assert.match(rendered.stderr, /error calling fail/);
  },
);

test("both consumers reject malformed JSON and unknown profiles", () => {
  assert.throws(() => parseProfileModel('{"profileModel":'), /not valid JSON/);
  const model = readProfileModel(modelPath);
  assert.throws(() => requireProfile(model, "unknown"), /unknown profile/);
  assert.throws(() => requireProfile(model, "constructor"), /unknown profile/);
  assert.notEqual(renderProfile("unknown").status, 0);

  assert.notEqual(renderProfile("workstation", '{"profileModel":').status, 0);
});
