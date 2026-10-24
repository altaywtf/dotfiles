import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "vite-plus/test";

import { parseCatalog, pickInstallTarget, satisfiesPin } from "./xcode.ts";

const installed = `26.6 (17F113) [Apple Silicon] (Selected)\t/Applications/Xcode-26.6.0.app
`;
const catalog = `
26.6 (17F113) [Apple Silicon] (Installed, Selected)
27.0 Beta 6 (27A5252f) [Apple Silicon]
27.0 Release Candidate (27A266a) [Apple Silicon]
`;

test("installed selected Xcode is parsed from xcodes output", () => {
  const [release] = parseCatalog(installed);
  assert.deepEqual(release, {
    version: "26.6",
    build: "17F113",
    selected: true,
    installed: true,
    path: "/Applications/Xcode-26.6.0.app",
  });
});

test("the declared pin matches only the numbered stable release", () => {
  assert.equal(satisfiesPin("26.6", "26.6"), true);
  assert.equal(satisfiesPin("27.0", "27.0"), true);
  assert.equal(satisfiesPin("27.0 Release Candidate", "27.0"), false);
  assert.equal(satisfiesPin("27.0 GM", "27.0"), false);
  assert.equal(satisfiesPin("27.0 Beta 6", "27.0"), false);
  assert.equal(satisfiesPin("26.6", "27.0"), false);
  assert.equal(pickInstallTarget(parseCatalog(catalog), "26.6")?.version, "26.6");
  assert.equal(pickInstallTarget(parseCatalog(catalog), "27.0"), undefined);
  assert.equal(
    pickInstallTarget(parseCatalog(`${catalog}27.0 (27A300) [Apple Silicon]\n`), "27.0")?.version,
    "27.0",
  );
});

function xcodeFixture(t: TestContext, release: string, xcodes: string, extraBin = {}) {
  const home = mkdtempSync(join(tmpdir(), "xcode-test."));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(home, "xcode.json"), `${JSON.stringify({ version: 1, release })}\n`);
  writeFileSync(join(home, "installed.txt"), installed);
  for (const [name, script] of Object.entries({ xcodes, ...extraBin }))
    writeFileSync(join(bin, name), script, { mode: 0o755 });
  const run = (args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}) =>
    spawnSync(process.execPath, [resolve(import.meta.dirname, "xcode.ts"), ...args], {
      encoding: "utf8",
      input: options.input,
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        DOTFILES_XCODE_FILE: join(home, "xcode.json"),
        ...options.env,
      },
    });
  return { bin, home, run };
}

const installedXcodes = `#!/bin/sh\nif [ "$1" = installed ]; then cat "$HOME/installed.txt"; exit 0; fi\nexit 1\n`;
const brew = '#!/bin/sh\nprintf "%s\\n" "$HOME"\n';

test.for([
  ["27.0", 1, "stderr", /selected Xcode is 26\.6 \(17F113\); pin is 27\.0/],
  ["26.6", 0, "stdout", /Xcode 26\.6 \(17F113\) matches pin 26\.6/],
] as const)("check against pin %s exits %i", ([release, status, stream, message], t) => {
  const result = xcodeFixture(t, release, installedXcodes).run(["--check"]);
  assert.equal(result.status, status, result.stderr);
  assert.match(result[stream], message);
});

test("install receives terminal input and preserves a failed install's exit status", (t) => {
  const xcodes = `#!/bin/sh
case "$1" in
  installed) exit 0 ;;
  list) printf '27.0 (27A266a) [Apple Silicon]\\n' ;;
  install)
    IFS= read -r response || exit 24
    [ "$response" = fixture-input ] || exit 25
    printf 'input received\\n'
    exit 23 ;;
  *) exit 26 ;;
esac
`;
  const result = xcodeFixture(t, "27.0", xcodes, { brew }).run([], { input: "fixture-input\n" });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stdout, /input received/);
  assert.match(result.stderr, /xcodes install exited 23/);
});

test("a refused non-interactive select names the exact sudo command", (t) => {
  const xcodes =
    "#!/bin/sh\n[ \"$1\" = installed ] && printf '27.0 (27A266a) [Apple Silicon]\\t/Applications/Xcode-27.0.0.app\\n'\nexit 0\n";
  const sudo = '#!/bin/sh\n[ "$1" = -n ] && exit 1\nexit 27\n';
  const { bin, home, run } = xcodeFixture(t, "27.0", xcodes, { brew, sudo });
  const result = run([], { env: { DEVBOX_CONFIG: join(home, "missing-devbox.env") } });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(
    result.stderr.includes(
      `run \`sudo ${join(bin, "xcodes")} select --no-color 27.0\` in a terminal`,
    ),
    result.stderr,
  );
});
