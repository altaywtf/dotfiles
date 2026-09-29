import { spawn } from "node:child_process";
import { Schema } from "effect";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import readline from "node:readline";
import { discoverCheckouts, projectTrustEdits, restrictCodexState } from "./projects.ts";

type RpcMessage = { id?: number; result?: unknown; error?: { message?: string } };
const RpcMessage = Schema.Struct({
  id: Schema.optional(Schema.Number),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});
type Scalar =
  | boolean
  | null
  | number
  | string
  | readonly string[]
  | Readonly<Record<string, string>>;
export type ConfigEdit = { keyPath: string; value: Scalar; mergeStrategy: "replace" | "upsert" };
type UserConfig = { projects: Readonly<Record<string, unknown>> };
type PlanEdits = (user: UserConfig) => readonly ConfigEdit[];

const ConfigRead = Schema.Struct({
  layers: Schema.Array(
    Schema.Struct({
      name: Schema.Struct({ type: Schema.String, file: Schema.optional(Schema.String) }),
      version: Schema.String,
      config: Schema.Struct({
        projects: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    }),
  ),
});

function userLayer(result: unknown, configPath: string) {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
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

function managedEdits(): ConfigEdit[] {
  return [
    { keyPath: "forced_login_method", value: null, mergeStrategy: "replace" },
    { keyPath: "model", value: "gpt-6.1-sol", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "upsert" },
    { keyPath: "service_tier", value: null, mergeStrategy: "replace" },
    // Auto review needs interactive approvals and a sandbox to escalate from.
    // Permission profiles replace sandbox_mode; Codex rejects combining them.
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
    // Every wait_agent poll re-sends the parent context. Codex defaults the
    // floor to 10 s and the default to 30 s; two minutes cuts empty polls
    // without stopping a worker from returning early on completion.
    {
      keyPath: "features.multi_agent_v2.min_wait_timeout_ms",
      value: 120000,
      mergeStrategy: "upsert",
    },
    {
      keyPath: "features.multi_agent_v2.default_wait_timeout_ms",
      value: 120000,
      mergeStrategy: "upsert",
    },
    { keyPath: "features.goals", value: true, mergeStrategy: "upsert" },
    { keyPath: "features.memories", value: false, mergeStrategy: "upsert" },
  ];
}

function codexHomePath(): string {
  return resolve(process.env.CODEX_HOME || join(process.env.HOME || "", ".codex"));
}

// A planner reads the user layer first and writes against its version, so a
// concurrent Codex edit fails the write instead of being overwritten.
export async function writeConfigEdits(edits: readonly ConfigEdit[] | PlanEdits): Promise<string> {
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
      if (settled) return;
      settled = true;
      lines.close();
      child.stdin.end();
      child.kill();
      reject(error);
    };
    child.once("error", (error) => fail(error));
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      if (completed && status === 0) finish();
      else reject(new Error(stderr.trim() || `Codex app-server exited ${status ?? 1}`));
    });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = Schema.decodeUnknownSync(RpcMessage)(JSON.parse(line));
      } catch {
        fail(new Error("Codex app-server returned invalid JSON"));
        return;
      }
      if (message.id === 0) {
        if (message.error)
          return fail(new Error(message.error.message || "Codex app-server initialization failed"));
        send({ method: "initialized", params: {} });
        if (typeof edits !== "function")
          send({ method: "config/batchWrite", id: 1, params: { edits, filePath: configPath } });
        else send({ method: "config/read", id: 2, params: { includeLayers: true } });
      }
      if (message.id === 2 && typeof edits === "function") {
        if (message.error)
          return fail(new Error(message.error.message || "Codex config read failed"));
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
            ...(current.version ? { expectedVersion: current.version } : {}),
          },
        });
      }
      if (message.id === 1) {
        if (message.error)
          return fail(new Error(message.error.message || "Codex config update failed"));
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

export type CodexDefaults = { configPath: string; restricted: readonly string[] };

// projectRoot opts into trusting every checkout directly under it.
export async function configureDefaults(projectRoot?: string): Promise<CodexDefaults> {
  const checkouts = projectRoot ? discoverCheckouts(projectRoot) : [];
  const configPath = await writeConfigEdits((user) => [
    ...managedEdits(),
    ...(projectRoot ? projectTrustEdits(projectRoot, checkouts, user.projects) : []),
  ]);
  return { configPath, restricted: restrictCodexState(codexHomePath()) };
}
