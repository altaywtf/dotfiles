import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vite-plus/test";

const helper = resolve(
  "chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_mise-github-token",
);

for (const [direct, status] of [
  [true, 0],
  [false, 0],
  [true, 17],
  [false, 17],
] as const) {
  test(`mise credential helper uses ${direct ? "PATH" : "an installed"} gh and forwards host and exit ${status}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "mise-gh-token-"));
    t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const gh = join(direct ? bin : root, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS"\n${status === 0 ? "printf fixture-credential" : ""}\nexit ${status}\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(
      join(bin, "mise"),
      `#!/bin/sh
[ "$MISE_OFFLINE" = 1 ] && [ -z "$MISE_GITHUB_CREDENTIAL_COMMAND" ] || exit 18
printf '%s\\n' "$@" > "$TEST_RESOLVE"
printf '%s\\n' "$TEST_GH"
`,
      { mode: 0o755 },
    );

    const result = spawnSync("/bin/sh", [helper], {
      encoding: "utf8",
      env: {
        PATH: bin,
        HOME: root,
        MISE_CREDENTIAL_HOST: "github.example.com",
        MISE_GITHUB_CREDENTIAL_COMMAND: "must not recurse",
        TEST_GH: gh,
        TEST_ARGS: join(root, "args"),
        TEST_RESOLVE: join(root, "resolve"),
      },
    });

    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, status === 0 ? "fixture-credential" : "");
    assert.equal(
      readFileSync(join(root, "args"), "utf8"),
      "auth\ntoken\n--hostname\ngithub.example.com\n",
    );

    if (!direct) {
      assert.equal(
        readFileSync(join(root, "resolve"), "utf8"),
        `-C\n${root}\nwhich\ngh\n--tool\ngh@latest\n`,
      );
    }
  });
}

test("missing gh stops without emitting a credential", () => {
  const result = spawnSync("/bin/sh", [helper], {
    encoding: "utf8",
    env: { PATH: "/nonexistent", HOME: "/nonexistent", MISE_CREDENTIAL_HOST: "github.com" },
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
