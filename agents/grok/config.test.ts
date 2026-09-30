import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { CommandRunner } from "../../lib/command.ts";

import { alignPinnedBinary, applyManagedSettings } from "./config.ts";

function table(contents: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = contents.split(new RegExp(`^\\[${escaped}\\][ \\t]*$`, "m"));
  assert.equal(matches.length, 2, `expected exactly one [${name}] table`);
  return matches[1].split(/^\[/m)[0].split("\n");
}

function assertManaged(contents: string): void {
  assert.ok(table(contents, "ui").includes('permission_mode = "auto"'));
  assert.ok(table(contents, "cli").includes("auto_update = false"));
  assert.ok(table(contents, "features").includes("telemetry = false"));
  assert.ok(table(contents, "features").includes("feedback = false"));
  assert.ok(table(contents, "telemetry").includes("trace_upload = false"));
  assert.ok(table(contents, "harness").includes("disable_workspace_teleport = true"));
  assert.ok(table(contents, "harness").includes("disable_codebase_upload = true"));
}

const live = `[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "Official"
git = "https://example.invalid/marketplace.git"

[cli]
auto_update = true
installer = "npm"

[ui]
yolo = false
permission_mode = "always-approve" # set from /settings
theme = "groknight"

[plugins]
enabled = [
    "ffss",
]

[mcp_servers.fixture]
command = "node"
args = ["/opt/fixture/[server].js", "--permission_mode=ask"]

[[hooks.Stop.hooks]]
type = "command"
command = 'node "/opt/fixture/stop.js"'

[model."grok-4.7"]
api_backend = "responses"
`;

test("managed Grok defaults replace drifted values in place", () => {
  const updated = applyManagedSettings(live);
  assertManaged(updated);
  assert.doesNotMatch(updated, /always-approve|auto_update = true/);
  for (const kept of [
    'installer = "npm"',
    '[plugins]\nenabled = [\n    "ffss",\n]',
    'theme = "groknight"',
    '[[marketplace.sources]]\nname = "Official"',
    'args = ["/opt/fixture/[server].js", "--permission_mode=ask"]',
    `[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 'node "/opt/fixture/stop.js"'`,
    '[model."grok-4.7"]\napi_backend = "responses"',
  ])
    assert.ok(updated.includes(kept), kept);
  assert.equal(applyManagedSettings(updated), updated);
});

test("managed Grok defaults create a configuration from nothing", () => {
  const created = applyManagedSettings("");
  assertManaged(created);
  assert.equal(applyManagedSettings(created), created);
});

test("root dotted keys extend their table in place", () => {
  const updated = applyManagedSettings('ui.theme = "groknight"\n\n[cli]\nauto_update = true\n');
  const root = updated.split(/^\[/m)[0].split("\n");
  assert.ok(root.includes('ui.theme = "groknight"'));
  assert.ok(root.includes('ui.permission_mode = "auto"'));
  assert.doesNotMatch(updated, /^\[ui\]$/m);
  assert.equal(applyManagedSettings(updated), updated);
});

test("inline managed tables are rejected rather than duplicated", () => {
  assert.throws(
    () => applyManagedSettings('ui = { theme = "groknight" }\n'),
    /defines ui as an inline table/,
  );
});

test("multi-line strings are never read as tables or keys", () => {
  const prompt = '[agents.fixture]\nprompt = """\n[ui]\npermission_mode = "ask"\n"""\n';
  const updated = applyManagedSettings(prompt);
  assert.ok(updated.startsWith(prompt));
  assertManaged(updated.slice(prompt.length));
});

test("compliant assignments keep their trailing comments", () => {
  const updated = applyManagedSettings("[cli]\nauto_update = false # pinned by mise\n");
  assert.ok(table(updated, "cli").includes("auto_update = false # pinned by mise"));
});

test("drift inside a string value is replaced", () => {
  const updated = applyManagedSettings('[ui]\npermission_mode = "a uto"\n');
  assert.ok(table(updated, "ui").includes('permission_mode = "auto"'));
});

test("quoted keys are updated instead of duplicated", () => {
  const updated = applyManagedSettings('[ui]\n"permission_mode" = "ask"\n');
  assert.deepEqual(
    table(updated, "ui").filter((line) => line.includes("permission_mode")),
    ['permission_mode = "auto"'],
  );
});

test("a compliant configuration is returned byte for byte", () => {
  const compliant = applyManagedSettings("");
  for (const variant of [compliant.trimEnd(), `${compliant}\n\n`])
    assert.equal(applyManagedSettings(variant), variant);
});

test("quoted table names are recognized", () => {
  const updated = applyManagedSettings('["ui"]\ntheme = "groknight"\n');
  assert.equal(updated.match(/^\[/gm)?.length, 5);
  assert.match(updated, /^\["ui"\]\ntheme = "groknight"\npermission_mode = "auto"$/m);
});

test("escaped quoted table names are decoded before matching", () => {
  const updated = applyManagedSettings('["\\u0075i"]\ntheme = "groknight"\n');
  assert.equal(updated.match(/^\[/gm)?.length, 5);
  assert.match(updated, /^\["\\u0075i"\]\ntheme = "groknight"\npermission_mode = "auto"$/m);
});

test("malformed configuration is refused rather than rewritten", () => {
  assert.throws(
    () => applyManagedSettings('[ui]\npermission_mode = [\ntheme = "groknight"\n'),
    /Grok config is not valid TOML at line \d+/,
  );
});

test("an interrupted restage puts the previous Grok link back", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-grok-align-"));
  context.onTestFinished(() => rmSync(root, { force: true, recursive: true }));
  const installDir = join(root, "pin");
  mkdirSync(join(installDir, "node_modules/@xai-official/grok"), { recursive: true });
  writeFileSync(
    join(installDir, "node_modules/@xai-official/grok/package.json"),
    JSON.stringify({ version: "2.0.0" }),
  );
  const grokHome = join(root, "grok");
  mkdirSync(join(grokHome, "bin"), { recursive: true });
  symlinkSync("grok-1.0.0", join(grokHome, "bin/grok"));
  let launched!: () => void;
  const launching = new Promise<void>((resolve) => (launched = resolve));
  const runner = CommandRunner.of({
    run: (command) => {
      if (command === "mise")
        return Effect.succeed({ status: 0, stdout: `${installDir}\n`, stderr: "" });
      return Effect.sync(launched).pipe(Effect.andThen(Effect.never));
    },
  });
  const fiber = Effect.runFork(
    alignPinnedBinary(grokHome).pipe(
      Effect.provideService(CommandRunner, runner),
      Effect.provide(NodeServices.layer),
    ),
  );
  await launching;
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(readlinkSync(join(grokHome, "bin/grok")), "grok-1.0.0");
});
