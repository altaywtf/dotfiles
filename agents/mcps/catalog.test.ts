import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vite-plus/test";

import { HARNESSES } from "../harness.ts";
import { readLayeredServers, readServers } from "./catalog.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryDirectories: string[] = [];
const fixtureSharedServers = [{ name: "shared-mcp", url: "https://mcp.fixture.test/mcp" }];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "dotfiles-mcp-catalog-"));
  temporaryDirectories.push(repoDir);
  mkdirSync(join(repoDir, "agents", "mcps"), { recursive: true });
  writeManifest(repoDir, "developer", fixtureSharedServers);
  for (const layer of ["workstation", "devbox", "personal"]) {
    writeManifest(repoDir, layer, []);
  }
  return { repoDir };
}

function manifestPath(repoDir: string, layer: string): string {
  return join(repoDir, "agents", "mcps", `${layer}.json`);
}

function writeManifest(repoDir: string, layer: string, servers: unknown): void {
  writeFileSync(manifestPath(repoDir, layer), JSON.stringify({ servers }, null, 2));
}

test("defaults a manifest entry to every harness", () => {
  const { repoDir } = createFixture();
  const servers = readServers(manifestPath(repoDir, "developer"));

  assert.equal(servers.length, 1);
  assert.deepEqual(servers[0]?.harnesses, HARNESSES);
});

const url = "https://mcp.fixture.test/mcp";

test.each([
  ["a non-https url", [{ name: "one", url: "http://mcp.fixture.test/mcp" }], /url must use https/],
  ["a malformed url", [{ name: "one", url: "not-a-url" }], /url is not a URL/],
  ["an unsafe name", [{ name: "../escape", url }], /expected safe server name and url strings/],
  ["a reserved name", [{ name: "__proto__", url }], /expected safe server name and url strings/],
  [
    "a duplicate name",
    [
      { name: "one", url },
      { name: "one", url },
    ],
    /defined more than once/,
  ],
  [
    "an unknown harness",
    [{ name: "one", url, harnesses: ["windsurf"] }],
    /harnesses must be a unique/,
  ],
])("rejects a manifest with %s", (_case, servers, message) => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", servers);
  assert.throws(() => readServers(manifestPath(repoDir, "developer")), message);
});

test("rejects a conflicting layered definition and collapses an identical one", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "personal", [
    { name: "shared-mcp", url: "https://other.fixture.test/mcp" },
  ]);
  assert.throws(
    () =>
      readLayeredServers(repoDir, "personal-workstation", ["developer", "workstation", "personal"]),
    /shared-mcp is defined more than once/,
  );

  writeManifest(repoDir, "personal", fixtureSharedServers);
  const { servers } = readLayeredServers(repoDir, "personal-workstation", [
    "developer",
    "workstation",
    "personal",
  ]);
  assert.deepEqual(
    servers.map((server) => server.name),
    ["shared-mcp"],
  );
});

test("every real MCP manifest parses", () => {
  for (const layer of ["developer", "workstation", "devbox", "personal"]) {
    readServers(join(repoRoot, `agents/mcps/${layer}.json`));
  }
});

test("local overlay servers append after profile layers and reject conflicts", () => {
  const { repoDir } = createFixture();
  const path = join(repoDir, "agents", "local.json");
  writeFileSync(
    path,
    JSON.stringify({
      servers: [
        { name: "local-mcp", url: "https://local.fixture.test/mcp", harnesses: ["claude"] },
      ],
    }),
    { mode: 0o600 },
  );
  const result = readLayeredServers(repoDir, "developer", ["developer"]);
  assert.deepEqual(result.layers, ["developer", "local"]);
  assert.equal(result.localPath, path);
  assert.deepEqual(
    result.servers.map((server) => [server.name, server.harnesses]),
    [
      ["shared-mcp", HARNESSES],
      ["local-mcp", ["claude"]],
    ],
  );

  writeFileSync(
    path,
    JSON.stringify({ servers: [{ name: "shared-mcp", url: "https://other.fixture.test/mcp" }] }),
  );
  assert.throws(
    () => readLayeredServers(repoDir, "developer", ["developer"]),
    /shared-mcp is defined more than once/,
  );

  writeFileSync(
    path,
    JSON.stringify({ servers: [{ name: "local-mcp", url: "http://local.fixture.test/mcp" }] }),
  );
  assert.throws(
    () => readLayeredServers(repoDir, "developer", ["developer"]),
    /agents\/local\.json: local-mcp url must use https/,
  );
});
