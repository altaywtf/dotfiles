import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail } from "../lib/program.ts";
import { type Harness, HARNESS_INFO, HARNESSES } from "./harness.ts";

const PACKAGE = "@vectorize-io/hindsight-coding-agents";

type Tarball = { url: string; sha256: string };
type ClientOverride = Tarball & { base: string; version: string };
export type Client = { version: string; tarball?: Tarball };

export const CLIENT_OVERRIDE: ClientOverride | undefined = undefined;

export function wantedClient(
  published: string,
  override: ClientOverride | undefined = CLIENT_OVERRIDE,
): Client {
  if (override === undefined || published !== override.base) return { version: published };
  return { version: override.version, tarball: { url: override.url, sha256: override.sha256 } };
}

const INSTALLER_NAMES: Record<Harness, string> = {
  claude: "claude-code",
  codex: "codex",
  grok: "grok-build",
};

const ServerConfig = Schema.Union([
  Schema.Struct({ serverMode: Schema.Literal("cloud"), apiToken: Schema.NonEmptyString }),
  Schema.Struct({ serverMode: Schema.Literal("self-hosted"), apiUrl: Schema.NonEmptyString }),
  Schema.Struct({ serverMode: Schema.Literal("daemon") }),
]);
const RuntimePackage = Schema.Struct({ version: Schema.NonEmptyString });
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
export type Paths = {
  home: string;
  configPath: string;
  runtimeDir: string;
};

export function defaultPaths(home: string, env: NodeJS.ProcessEnv = process.env): Paths {
  return {
    home,
    configPath: env.HINDSIGHT_CONFIG || join(home, ".hindsight/coding-agent.json"),
    runtimeDir: join(home, ".hindsight/coding-agents"),
  };
}

const failure = (message: string) => new CliFailure({ exitCode: 1, message });

const setupHint = (configPath: string) =>
  `Hindsight is not configured: ${configPath} has no server. Run once with your server, for example:\n` +
  `  umask 077\n` +
  `  npx -y ${PACKAGE}@latest install claude-code --server self-hosted --api-url <url>\n` +
  `Set apiToken in ${configPath} using a private local editor; keep the other settings and mode 0600. ` +
  `Passing the token through --api-token exposes it in process arguments.`;

const readText = Effect.fn("readText")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return undefined;
  return yield* fs.readFileString(path);
});

const readJson = Effect.fn("readJson")(function* (path: string) {
  const text = yield* readText(path);
  if (text === undefined) return undefined;
  const parsed = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => path });
  return yield* Schema.decodeUnknownEffect(JsonObject)(parsed).pipe(Effect.mapError(() => path));
});

// The server endpoint and token are machine-local credentials; setup requires
// them to exist and never writes them.
const requireServerConfig = Effect.fn("requireServerConfig")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(configPath).pipe(Effect.option);
  if (Option.isNone(info)) return yield* fail(setupHint(configPath));
  const link = yield* fs.readLink(configPath).pipe(Effect.option);
  if (Option.isSome(link) || info.value.type !== "File")
    return yield* fail(`${configPath} must be a regular file`);
  if ((info.value.mode & 0o077) !== 0)
    return yield* fail(`${configPath} must not be readable by group or others`);
  const config = yield* readJson(configPath).pipe(
    Effect.mapError(() => failure(`${configPath} must contain a JSON object`)),
  );
  return yield* Schema.decodeUnknownEffect(ServerConfig)(config).pipe(
    Effect.mapError(() => failure(setupHint(configPath))),
  );
});

type Credentials = { apiToken?: string; apiUrl?: string };
export type RepoCredential = { bank: string; credentials: Credentials };

function credentialsOf(value: unknown): Credentials | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Credentials = {};
  if ("apiToken" in value && typeof value.apiToken === "string") out.apiToken = value.apiToken;
  if ("apiUrl" in value && typeof value.apiUrl === "string") out.apiUrl = value.apiUrl;
  return out.apiToken === undefined && out.apiUrl === undefined ? undefined : out;
}

const expandHome = (home: string, dir: string) =>
  dir === "~" || dir.startsWith("~/") ? join(home, dir.slice(1)) : dir;

// The published runtime selects credentials only per bank, so every repository directly under a
// `paths.<prefix>` entry gets that entry's credentials as `banks.coding-agent::<repo>`, the id the
// runtime derives by default. The longest prefix wins, as it does for `mapPathToBank`.
export function pathCredentialDrift(
  home: string,
  config: Record<string, unknown>,
  repositories: (directory: string) => readonly string[],
): RepoCredential[] {
  const paths = config.paths;
  if (typeof paths !== "object" || paths === null || config.bankIdTemplate || config.bankId)
    return [];
  const wanted = new Map<string, { depth: number; credentials: Credentials }>();
  for (const [prefix, section] of Object.entries(paths)) {
    const credentials = credentialsOf(section);
    if (credentials === undefined) continue;
    const directory = expandHome(home, prefix).replace(/\/+$/, "");
    for (const repository of repositories(directory)) {
      const bank = `coding-agent::${repository}`;
      const current = wanted.get(bank);
      if (current === undefined || directory.length > current.depth)
        wanted.set(bank, { depth: directory.length, credentials });
    }
  }
  const banks = typeof config.banks === "object" && config.banks !== null ? config.banks : {};
  return [...wanted]
    .filter(([bank, { credentials }]) => {
      const section: Record<string, unknown> =
        bank in banks ? ((banks as Record<string, unknown>)[bank] as Record<string, unknown>) : {};
      return Object.entries(credentials).some(([key, value]) => section?.[key] !== value);
    })
    .map(([bank, { credentials }]) => ({ bank, credentials }))
    .sort((a, b) => a.bank.localeCompare(b.bank));
}

const listRepositories = Effect.fn("listRepositories")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const repositories: string[] = [];
  for (const name of names.toSorted((a, b) => a.localeCompare(b))) {
    if (yield* fs.exists(join(directory, name, ".git")).pipe(Effect.orElseSucceed(() => false)))
      repositories.push(name);
  }
  return repositories;
});

const repositoryIndex = Effect.fn("repositoryIndex")(function* (
  home: string,
  config: Record<string, unknown>,
) {
  const index = new Map<string, readonly string[]>();
  const paths = config.paths;
  if (typeof paths !== "object" || paths === null) return index;
  for (const prefix of Object.keys(paths)) {
    const directory = expandHome(home, prefix).replace(/\/+$/, "");
    index.set(directory, yield* listRepositories(directory));
  }
  return index;
});

const writeBankCredentials = Effect.fn("writeBankCredentials")(function* (
  configPath: string,
  config: Record<string, unknown>,
  drift: readonly RepoCredential[],
) {
  const fs = yield* FileSystem.FileSystem;
  const banks: Record<string, unknown> =
    typeof config.banks === "object" && config.banks !== null ? { ...config.banks } : {};
  for (const { bank, credentials } of drift) {
    const section = banks[bank];
    banks[bank] = {
      ...(typeof section === "object" && section !== null ? section : {}),
      ...credentials,
    };
  }
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: dirname(configPath),
        prefix: ".coding-agent.json.",
      });
      const temporary = join(directory, "coding-agent.json");
      yield* fs.writeFileString(temporary, `${JSON.stringify({ ...config, banks }, null, 2)}\n`, {
        mode: 0o600,
      });
      yield* fs.rename(temporary, configPath);
      yield* fs.chmod(configPath, 0o600);
    }),
  );
});

// Every managed harness reads its own config; a missing HINDSIGHT_MCP_HARNESS
// is the drift that leaves the MCP server dead after a runtime update.
export function wiredInText(
  harness: Exclude<Harness, "claude">,
  toml: string | undefined,
): boolean {
  if (toml === undefined) return false;
  // Codex writes the env as its own table; Grok inlines it under the server table.
  return (
    /^\[mcp_servers\.hindsight\]/m.test(toml) &&
    new RegExp(`HINDSIGHT_MCP_HARNESS\\s*=\\s*"${INSTALLER_NAMES[harness]}"`).test(toml)
  );
}

function mcpEnvMatches(servers: unknown, name: string): boolean {
  if (typeof servers !== "object" || servers === null || !("hindsight" in servers)) return false;
  const server = servers.hindsight;
  if (typeof server !== "object" || server === null || !("env" in server)) return false;
  const env = server.env;
  return (
    typeof env === "object" &&
    env !== null &&
    "HINDSIGHT_MCP_HARNESS" in env &&
    env.HINDSIGHT_MCP_HARNESS === name
  );
}

const wired = Effect.fn("wired")(function* (paths: Paths, harness: Harness) {
  switch (harness) {
    case "claude": {
      const config = yield* readJson(join(paths.home, ".claude.json")).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      return mcpEnvMatches(config?.mcpServers, INSTALLER_NAMES.claude);
    }
    case "codex":
      return wiredInText(harness, yield* readText(join(paths.home, ".codex/config.toml")));
    case "grok":
      return wiredInText(harness, yield* readText(join(paths.home, ".grok/config.toml")));
  }
});

const installedVersion = Effect.fn("installedVersion")(function* (runtimeDir: string) {
  const parsed = yield* readJson(join(runtimeDir, "package.json")).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return Schema.is(RuntimePackage)(parsed) ? parsed.version : undefined;
});

const latestVersion = Effect.fn("latestVersion")(function* () {
  const runner = yield* CommandRunner;
  const result = yield* runner
    .run("npm", ["view", PACKAGE, "version"], { timeoutMs: 60_000 })
    .pipe(Effect.mapError((error) => failure(`npm view failed: ${error.message}`)));
  const version = result.stdout.trim();
  if (result.status !== 0 || !/^\d+\.\d+\.\d+/.test(version))
    return yield* fail(`npm view ${PACKAGE} version failed: ${result.stderr.trim() || version}`);
  return version;
});

type Report = {
  harnesses: readonly Harness[];
  installed: string | undefined;
  wanted: Client;
  unwired: readonly Harness[];
  config: Record<string, unknown>;
  credentials: readonly RepoCredential[];
};

const inspect = Effect.fn("inspectHindsight")(function* (
  paths: Paths,
  commandExists: (binary: string) => boolean,
) {
  yield* requireServerConfig(paths.configPath);
  const config =
    (yield* readJson(paths.configPath).pipe(Effect.orElseSucceed(() => undefined))) ?? {};
  const index = yield* repositoryIndex(paths.home, config);
  const credentials = pathCredentialDrift(paths.home, config, (dir) => index.get(dir) ?? []);
  const harnesses = HARNESSES.filter((harness) => commandExists(HARNESS_INFO[harness].binary));
  const [installed, latest] = yield* Effect.all([
    installedVersion(paths.runtimeDir),
    latestVersion(),
  ]);
  const unwired: Harness[] = [];
  for (const harness of harnesses) {
    if (!(yield* wired(paths, harness))) unwired.push(harness);
  }
  return {
    harnesses,
    installed,
    wanted: wantedClient(latest),
    unwired,
    config,
    credentials,
  } satisfies Report;
});

const drift = (report: Report): string[] => [
  ...(report.installed === report.wanted.version
    ? []
    : [`runtime ${report.installed ?? "missing"} differs from wanted ${report.wanted.version}`]),
  ...report.unwired.map(
    (harness) => `${HARNESS_INFO[harness].label} is not wired with HINDSIGHT_MCP_HARNESS`,
  ),
  ...report.credentials.map(({ bank }) => `${bank} lacks its paths credentials`),
];

const runInstaller = Effect.fn("runInstaller")(function* (args: string[]) {
  const runner = yield* CommandRunner;
  yield* Console.log(`hindsight: npx ${args.join(" ")}`);
  const result = yield* runner
    .run("npx", args, { output: "inherit", timeoutMs: 10 * 60_000 })
    .pipe(Effect.mapError((error) => failure(`npx failed: ${error.message}`)));
  if (result.status !== 0) return yield* fail(`hindsight install exited with ${result.status}`);
});

const installClient = Effect.fn("installClient")(function* (
  client: Client,
  targets: readonly string[],
) {
  const tarball = client.tarball;
  if (tarball === undefined)
    return yield* runInstaller(["-y", `${PACKAGE}@latest`, "install", ...targets]);
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-hindsight." });
      const file = join(directory, "client.tgz");
      const download = yield* runner
        .run("curl", ["-fsSL", "--retry", "2", "-o", file, tarball.url], { timeoutMs: 5 * 60_000 })
        .pipe(Effect.mapError((error) => failure(`curl failed: ${error.message}`)));
      if (download.status !== 0)
        return yield* fail(`download of ${tarball.url} failed: ${download.stderr.trim()}`);
      const bytes = yield* fs
        .readFile(file)
        .pipe(Effect.mapError(() => failure(`cannot read the download of ${tarball.url}`)));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== tarball.sha256)
        return yield* fail(`${tarball.url} has sha256 ${digest}, expected ${tarball.sha256}`);
      yield* runInstaller([
        "-y",
        `--package=${file}`,
        "hindsight-coding-agents",
        "install",
        ...targets,
      ]);
    }),
  );
});

// The installer is idempotent per harness: it re-stages the runtime and rewrites
// exactly its own hook and MCP entries, leaving user config alone.
export const configureHindsight = Effect.fn("configureHindsight")(function* (
  paths: Paths,
  commandExists: (binary: string) => boolean,
  check: boolean,
) {
  let report = yield* inspect(paths, commandExists);
  if (report.credentials.length > 0 && !check) {
    yield* writeBankCredentials(paths.configPath, report.config, report.credentials);
    yield* Console.log(
      `hindsight: set paths credentials for ${report.credentials.map(({ bank }) => bank).join(", ")}`,
    );
    report = yield* inspect(paths, commandExists);
  }
  if (report.harnesses.length === 0) {
    yield* Console.log("hindsight: no managed coding agent installed; nothing to wire");
    return;
  }
  const reasons = drift(report);
  if (reasons.length === 0) {
    yield* Console.log(
      `hindsight: ${report.wanted.version} wired for ${report.harnesses.map((h) => INSTALLER_NAMES[h]).join(", ")}`,
    );
    return;
  }
  if (check) return yield* fail(`hindsight drift:\n  - ${reasons.join("\n  - ")}`);

  const targets = report.harnesses.map((harness) => INSTALLER_NAMES[harness]);
  yield* Console.log(`hindsight: ${reasons.join("; ")}`);
  yield* installClient(report.wanted, targets);

  const after = yield* inspect(paths, commandExists);
  const remaining = drift(after);
  if (remaining.length > 0)
    return yield* fail(`hindsight drift after install:\n  - ${remaining.join("\n  - ")}`);
  yield* Console.log(`hindsight: ${after.wanted.version} wired for ${targets.join(", ")}`);
});
