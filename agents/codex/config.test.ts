import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vite-plus/test";

import { writeConfigEdits } from "./config.ts";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(reply: string) {
  const home = mkdtempSync(join(tmpdir(), "dotfiles-codex-writer-"));
  directories.push(home);
  const binary = join(home, "codex");
  const config = join(home, "config.toml");
  writeFileSync(config, "# preserved\n", { mode: 0o644 });
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  ${reply}
});
`,
    { mode: 0o700 },
  );
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("CODEX_CONFIG_PATH", config);
  vi.stubEnv("CODEX_BIN", binary);
  return { config, home };
}

test("native write completes before returning the private configuration path", async () => {
  const { config, home } = fixture(`
    if (request.method === "initialize") process.stdout.write('{"id":0,"result":{}}\\n');
    if (request.method === "config/batchWrite") {
      fs.writeFileSync(request.params.filePath, '# updated\\n');
      fs.writeFileSync(require("node:path").join(process.env.CODEX_HOME, "request.json"), JSON.stringify(request.params));
      process.stdout.write('{"id":1,"result":{}}\\n');
    }
  `);
  const edits = [{ keyPath: "example", value: true, mergeStrategy: "upsert" }] as const;
  assert.equal(await writeConfigEdits(edits), config);
  assert.equal(readFileSync(config, "utf8"), "# updated\n");
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "request.json"), "utf8")), {
    edits,
    filePath: config,
  });
});

test.each([
  [
    "a malformed reply",
    `process.stdout.write('{"id":"invalid"}\\n');`,
    /Codex app-server returned invalid JSON/,
  ],
  [
    "a nonzero exit",
    `process.stderr.write('fixture write failure'); process.exit(17);`,
    /fixture write failure/,
  ],
])("%s rejects with its diagnostic and preserves configuration", async (_case, reply, error) => {
  const { config } = fixture(reply);
  await assert.rejects(writeConfigEdits([]), error);
  assert.equal(readFileSync(config, "utf8"), "# preserved\n");
  assert.equal(statSync(config).mode & 0o777, 0o644);
});

test("planned edits read the user layer and write against its version", async () => {
  const { config, home } = fixture(`
    if (request.method === "initialize") process.stdout.write('{"id":0,"result":{}}\\n');
    if (request.method === "config/read") {
      const layers = [
        { name: { type: "system", file: "/etc/codex/config.toml" }, version: "system", config: { projects: { "/system": {} } } },
        { name: { type: "user", file: process.env.CODEX_CONFIG_PATH }, version: "sha256:user", config: { projects: { "/kept": {} } } },
      ];
      process.stdout.write(JSON.stringify({ id: 2, result: { config: {}, layers } }) + "\\n");
    }
    if (request.method === "config/batchWrite") {
      fs.writeFileSync(require("node:path").join(process.env.CODEX_HOME, "request.json"), JSON.stringify(request.params));
      process.stdout.write('{"id":1,"result":{}}\\n');
    }
  `);
  const seen: unknown[] = [];
  const edit = { keyPath: "example", value: true, mergeStrategy: "upsert" } as const;
  assert.equal(
    await writeConfigEdits((user) => {
      seen.push(user.projects);
      return [edit];
    }),
    config,
  );
  assert.deepEqual(seen, [{ "/kept": {} }]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "request.json"), "utf8")), {
    edits: [edit],
    filePath: config,
    expectedVersion: "sha256:user",
  });
});
