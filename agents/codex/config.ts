import { spawn } from "node:child_process";
import { Predicate, Schema } from "effect";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { discoverCheckouts, projectTrustEdits, restrictCodexState } from "./projects.ts";

const RpcMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  }),
);
type RpcMessage = typeof RpcMessage.Type;
const Scalar = Schema.Union([
  Schema.Boolean,
  Schema.Null,
  Schema.Number,
  Schema.String,
  Schema.Array(Schema.String),
  Schema.Record(Schema.String, Schema.String),
]);
type Scalar = typeof Scalar.Type;
const LocalSettings = Schema.fromJsonString(Schema.Record(Schema.String, Scalar));
export type ConfigEdit = { keyPath: string; value: Scalar; mergeStrategy: "replace" | "upsert" };
type UserConfig = { projects: Readonly<Record<string, Schema.Json>> };
type PlanEdits = (user: UserConfig) => ReadonlyArray<ConfigEdit>;

const ConfigRead = Schema.Struct({
  layers: Schema.Array(
    Schema.Struct({
      name: Schema.Struct({ type: Schema.String, file: Schema.optional(Schema.String) }),
      version: Schema.String,
      config: Schema.Struct({
        projects: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
      }),
    }),
  ),
});

const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));

function userLayer(result: unknown, configPath: string) {
  const layer = Schema.decodeUnknownSync(ConfigRead)(result).layers.find(
    (candidate) =>
      candidate.name.type === "user" &&
      candidate.name.file !== undefined &&
      real(candidate.name.file) === real(configPath),
  );
  return {
    version: layer?.version,
    user: { projects: layer?.config.projects ?? {} },
  };
}

function managedEdits(): Array<ConfigEdit> {
  return [
    { keyPath: "forced_login_method", value: null, mergeStrategy: "replace" },
    { keyPath: "model", value: "gpt-6.2-sol", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "upsert" },
    { keyPath: "service_tier", value: null, mergeStrategy: "replace" },
    { keyPath: "approval_policy", value: "on-request", mergeStrategy: "replace" },
    { keyPath: "approvals_reviewer", value: "auto_review", mergeStrategy: "replace" },
    { keyPath: "default_permissions", value: ":workspace", mergeStrategy: "replace" },
    { keyPath: "sandbox_mode", value: null, mergeStrategy: "replace" },
    { keyPath: "analytics.enabled", value: false, mergeStrategy: "upsert" },
    { keyPath: "feedback.enabled", value: false, mergeStrategy: "upsert" },
    { keyPath: "otel.metrics_exporter", value: "none", mergeStrategy: "upsert" },
    { keyPath: "features.fast_mode", value: null, mergeStrategy: "replace" },
    {
      keyPath: "features.context_management.experimental_mode",
      value: true,
      mergeStrategy: "upsert",
    },
    {
      keyPath: "features.multi_agent_v2.min_wait_timeout_ms",
      value: 120_000,
      mergeStrategy: "upsert",
    },
    {
      keyPath: "features.multi_agent_v2.default_wait_timeout_ms",
      value: 120_000,
      mergeStrategy: "upsert",
    },
    { keyPath: "features.goals", value: true, mergeStrategy: "upsert" },
    { keyPath: "features.memories", value: false, mergeStrategy: "upsert" },
  ];
}

function localEdits(path: string): Array<ConfigEdit> {
  if (!existsSync(path)) {
    return [];
  }
  let settings: typeof LocalSettings.Type;
  try {
    settings = Schema.decodeUnknownSync(LocalSettings)(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} must be a JSON object of Codex key paths to values`, { cause: error });
  }
  return Object.entries(settings).map(([keyPath, value]) => ({
    keyPath,
    value,
    mergeStrategy: "upsert",
  }));
}

const Gateway = Schema.fromJsonString(
  Schema.Struct({ baseUrl: Schema.String, keyCommand: Schema.String }),
);

function gatewayEdits(path: string): Array<ConfigEdit> {
  if (!existsSync(path)) {
    return [];
  }
  let gateway: typeof Gateway.Type;
  try {
    gateway = Schema.decodeUnknownSync(Gateway)(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} must be a JSON object with baseUrl and keyCommand strings`, {
      cause: error,
    });
  }
  const provider = "model_providers.gateway";
  return [
    { keyPath: "model_provider", value: "gateway", mergeStrategy: "replace" },
    { keyPath: `${provider}.name`, value: "Gateway", mergeStrategy: "replace" },
    { keyPath: `${provider}.base_url`, value: gateway.baseUrl, mergeStrategy: "replace" },
    { keyPath: `${provider}.wire_api`, value: "responses", mergeStrategy: "replace" },
    { keyPath: `${provider}.requires_openai_auth`, value: false, mergeStrategy: "replace" },
    { keyPath: `${provider}.supports_websockets`, value: true, mergeStrategy: "replace" },
    {
      keyPath: `${provider}.http_headers`,
      value: { "X-OpenAI-Actor-Authorization": "local-proxy" },
      mergeStrategy: "replace",
    },
    { keyPath: `${provider}.auth.command`, value: gateway.keyCommand, mergeStrategy: "replace" },
    { keyPath: `${provider}.auth.timeout_ms`, value: 10_000, mergeStrategy: "replace" },
    { keyPath: `${provider}.auth.refresh_interval_ms`, value: 0, mergeStrategy: "replace" },
  ];
}

function codexHomePath(): string {
  return resolve(process.env.CODEX_HOME || join(process.env.HOME || "", ".codex"));
}

export async function writeConfigEdits(
  edits: ReadonlyArray<ConfigEdit> | PlanEdits,
): Promise<string> {
  const codexHome = codexHomePath();
  const configPath = resolve(process.env.CODEX_CONFIG_PATH || join(codexHome, "config.toml"));
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });

  const child = spawn(process.env.CODEX_BIN || "codex", ["app-server"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

  await new Promise<void>((finish, reject) => {
    let completed = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      lines.close();
      child.stdin.end();
      child.kill();
      reject(error);
    };
    child.once("error", (error) => fail(error));
    child.once("close", (status) => {
      if (settled) {
        return;
      }
      settled = true;
      if (completed && status === 0) {
        finish();
      } else {
        reject(new Error(stderr.trim() || `Codex app-server exited ${status ?? 1}`));
      }
    });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = Schema.decodeUnknownSync(RpcMessage)(line);
      } catch {
        fail(new Error("Codex app-server returned invalid JSON"));
        return;
      }
      if (message.id === 0) {
        if (message.error) {
          return fail(new Error(message.error.message || "Codex app-server initialization failed"));
        }
        send({ method: "initialized", params: {} });
        if (!Predicate.isFunction(edits)) {
          send({ method: "config/batchWrite", id: 1, params: { edits, filePath: configPath } });
        } else {
          send({ method: "config/read", id: 2, params: { includeLayers: true } });
        }
      }
      if (message.id === 2 && Predicate.isFunction(edits)) {
        if (message.error) {
          return fail(new Error(message.error.message || "Codex config read failed"));
        }
        let current: ReturnType<typeof userLayer>;
        try {
          current = userLayer(message.result, configPath);
        } catch {
          return fail(new Error("Codex app-server returned an unexpected configuration"));
        }
        send({
          method: "config/batchWrite",
          id: 1,
          params: {
            edits: edits(current.user),
            filePath: configPath,
            expectedVersion: current.version || undefined,
          },
        });
      }
      if (message.id === 1) {
        if (message.error) {
          return fail(new Error(message.error.message || "Codex config update failed"));
        }
        completed = true;
        child.stdin.end();
      }
    });
    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: { name: "dotfiles_bootstrap", title: "Dotfiles Bootstrap", version: "1" },
      },
    });
  });
  chmodSync(configPath, 0o600);
  return configPath;
}

export type CodexDefaults = { configPath: string; restricted: ReadonlyArray<string> };

export async function configureDefaults(
  projectRoot?: string,
  gateway = false,
): Promise<CodexDefaults> {
  const checkouts = projectRoot ? discoverCheckouts(projectRoot) : [];
  const home = process.env.HOME || "";
  const local = localEdits(join(home, ".config/dotfiles/codex.json"));
  const overridden = new Set(local.map((edit) => edit.keyPath));
  const managed = [
    ...managedEdits(),
    ...(gateway ? gatewayEdits(join(home, ".config/dotfiles/t3-gateway.json")) : []),
  ];
  const configPath = await writeConfigEdits((user) => [
    ...managed.filter((edit) => !overridden.has(edit.keyPath)),
    ...local,
    ...(projectRoot ? projectTrustEdits(projectRoot, checkouts, user.projects) : []),
  ]);
  return { configPath, restricted: restrictCodexState(codexHomePath()) };
}
