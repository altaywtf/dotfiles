import { bundleGatewayHelpers } from "./bundle.ts";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { writeConfigEdits } from "../codex/config.ts";

import {
  type GatewayConfig,
  parseGatewayConfig,
  gatewayEdits,
  codexGatewaiOverrides,
} from "./gateway-config.ts";

type ClientState = {
  version: 9;
  codexConfigExisted: boolean;
  codexBackupPath: string | null;
  claudeSettingsExisted: boolean;
  claudeBackupPath: string | null;
  grokEnabled: boolean;
  grokConfigExisted: boolean;
  grokConfigBackupPath: string | null;
  grokAuthExisted: boolean;
  grokAuthBackupPath: string | null;
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownerOnly(path: string): boolean {
  return (statSync(path).mode & 0o077) === 0;
}

export function claudeGatewayBaseUrl(gatewaiBaseUrl: string): string {
  const url = new URL(gatewaiBaseUrl);
  url.pathname = url.pathname.slice(0, -3) || "/";
  return url.toString().replace(/\/$/, "");
}

export function claudeGatewaySettings(
  contents: string,
  gatewaiBaseUrl: string,
  credentialPath: string,
): Record<string, unknown> {
  const value: unknown = contents.trim() === "" ? {} : JSON.parse(contents);
  if (!isRecord(value)) throw new Error("Claude settings must contain a JSON object");
  const currentEnv = value.env === undefined ? {} : value.env;
  if (!isRecord(currentEnv)) throw new Error("Claude settings env must contain a JSON object");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    if (key in currentEnv)
      throw new Error(`Claude settings env conflicts with the gateway: ${key}`);
  }
  return {
    ...value,
    apiKeyHelper: `${credentialPath} gatewai`,
    env: { ...currentEnv, ANTHROPIC_BASE_URL: claudeGatewayBaseUrl(gatewaiBaseUrl) },
  };
}

function atomicCopy(source: string, target: string, mode: number): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  copyFileSync(source, temporary);
  chmodSync(temporary, mode);
  renameSync(temporary, target);
}

function atomicWriteJson(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function atomicWriteText(target: string, value: string, mode: number): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, value, { mode });
  renameSync(temporary, target);
}

function captureOptionalBackup(
  source: string,
  backup: string,
  label: string,
): { existed: boolean; backupPath: string | null } {
  const existed = existsSync(source);
  if (existed && existsSync(backup))
    throw new Error(`refusing to overwrite existing ${label} backup: ${backup}`);
  if (existed) atomicCopy(source, backup, 0o600);
  return { existed, backupPath: existed ? backup : null };
}

function restoreGrok(state: ClientState, grokConfig: string, grokAuth: string): void {
  if (state.grokConfigExisted) {
    if (!state.grokConfigBackupPath || !existsSync(state.grokConfigBackupPath))
      throw new Error("Grok config rollback backup is missing");
    atomicCopy(state.grokConfigBackupPath, grokConfig, 0o600);
  } else {
    rmSync(grokConfig, { force: true });
  }
  if (state.grokAuthExisted) {
    if (!state.grokAuthBackupPath || !existsSync(state.grokAuthBackupPath))
      throw new Error("Grok auth rollback backup is missing");
    atomicCopy(state.grokAuthBackupPath, grokAuth, 0o600);
  } else {
    rmSync(grokAuth, { force: true });
  }
  if (state.grokConfigBackupPath) rmSync(state.grokConfigBackupPath, { force: true });
  if (state.grokAuthBackupPath) rmSync(state.grokAuthBackupPath, { force: true });
}

function readState(path: string): ClientState {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) {
    throw new Error("LLM gateway state has an invalid shape");
  }
  const versioned =
    value.version === 9 &&
    exactKeys(value, [
      "version",
      "codexConfigExisted",
      "codexBackupPath",
      "claudeSettingsExisted",
      "claudeBackupPath",
      "grokEnabled",
      "grokConfigExisted",
      "grokConfigBackupPath",
      "grokAuthExisted",
      "grokAuthBackupPath",
    ]);
  if (!versioned)
    throw new Error(
      "LLM gateway state must use version 9; follow the breaking-release migration instructions",
    );
  if (
    typeof value.codexConfigExisted !== "boolean" ||
    !(value.codexBackupPath === null || typeof value.codexBackupPath === "string")
  ) {
    throw new Error("LLM gateway state has invalid values");
  }
  if (
    typeof value.claudeSettingsExisted !== "boolean" ||
    !(value.claudeBackupPath === null || typeof value.claudeBackupPath === "string")
  ) {
    throw new Error("LLM gateway state has invalid Claude settings values");
  }
  if (typeof value.grokEnabled !== "boolean")
    throw new Error("LLM gateway state has an invalid Grok value");
  if (
    typeof value.grokConfigExisted !== "boolean" ||
    !(value.grokConfigBackupPath === null || typeof value.grokConfigBackupPath === "string")
  ) {
    throw new Error("LLM gateway state has invalid Grok config values");
  }
  if (
    typeof value.grokAuthExisted !== "boolean" ||
    !(value.grokAuthBackupPath === null || typeof value.grokAuthBackupPath === "string")
  ) {
    throw new Error("LLM gateway state has invalid Grok auth values");
  }
  return value as ClientState;
}

const grokGatewayBegin = "# BEGIN dotfiles LLM gateway";
const grokGatewayEnd = "# END dotfiles LLM gateway";
const grokGatewayPattern = new RegExp(
  `${grokGatewayBegin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${grokGatewayEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
  "g",
);

function grokGatewayBlock(gatewaiBaseUrl: string, credentialPath: string): string {
  return [
    grokGatewayBegin,
    "[models]",
    'default = "grok-4.7"',
    'default_reasoning_effort = "high"',
    "",
    "[endpoints]",
    `models_base_url = ${JSON.stringify(gatewaiBaseUrl)}`,
    "",
    "[auth]",
    `auth_provider_command = ${JSON.stringify(`${credentialPath} gatewai`)}`,
    'auth_provider_label = "Gatewai"',
    "auth_token_ttl = 3600",
    "",
    '[model."grok-4.7"]',
    'api_backend = "responses"',
    grokGatewayEnd,
  ].join("\n");
}

function grokUnmarkedGatewayPattern(gatewaiBaseUrl: string, credentialPath: string): RegExp {
  // Native TOML rewrites can drop comments. Recognize only our exact configured
  // sections; different values or extra managed-table keys remain conflicts.
  // Another tool's comment marker may follow a section.
  // Grok's serializer writes integers with digit separators (3600 -> 3_600).
  const body = grokGatewayBlock(gatewaiBaseUrl, credentialPath)
    .split("\n")
    .slice(1, -1)
    .join("\n")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/(?<== )\d+$/gm, (digits) => digits.split("").join("_?"));
  return new RegExp(`(?:^|\\n)${body}(?=\\n\\s*(?:\\[|#|$)|$)`, "g");
}

export function grokGatewaySettings(
  contents: string,
  gatewaiBaseUrl: string,
  credentialPath: string,
): string {
  const original = contents
    .replace(grokGatewayPattern, "")
    .replace(grokUnmarkedGatewayPattern(gatewaiBaseUrl, credentialPath), "")
    .trimEnd();
  for (const section of ["models", "endpoints", "auth", 'model."grok-4.7"']) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, "m").test(original)) {
      throw new Error(`Grok config conflicts with gateway section: ${section}`);
    }
  }
  return `${original}${original ? "\n\n" : ""}${grokGatewayBlock(gatewaiBaseUrl, credentialPath)}\n`;
}

function validateLocalInputs(configPath: string): GatewayConfig {
  if (
    !existsSync(configPath) ||
    lstatSync(configPath).isSymbolicLink() ||
    !lstatSync(configPath).isFile()
  ) {
    throw new Error(`gateway config must be a regular file: ${configPath}`);
  }
  if (!ownerOnly(configPath))
    throw new Error("gateway config must not be accessible by group or other users");
  const config = parseGatewayConfig(readFileSync(configPath, "utf8"));
  if (
    config.grokBin &&
    (!existsSync(config.grokBin) || (statSync(config.grokBin).mode & 0o111) === 0)
  ) {
    throw new Error("grokBin must be executable");
  }
  return config;
}

function assertInstalledFile(source: string, target: string): void {
  if (!existsSync(target) || source !== readFileSync(target, "utf8")) {
    throw new Error(`installed helper drifted: ${target}`);
  }
  if ((statSync(target).mode & 0o777) !== 0o700)
    throw new Error(`installed helper mode drifted: ${target}`);
}

type GatewayOperation = "apply" | "check" | "rollback";

export async function configureGateway(
  mode: GatewayOperation | "setup" | "maintenance",
): Promise<void> {
  if (mode === "setup" || mode === "maintenance") {
    const configPath = resolve(
      process.env.LLM_GATEWAY_CONFIG ||
        join(process.env.HOME || "", ".config/dotfiles/llm-gateway.json"),
    );
    validateLocalInputs(configPath);
    await configureGateway("apply");
    return;
  }

  const home = resolve(process.env.HOME || "");
  const codexHome = resolve(process.env.CODEX_HOME || join(home, ".codex"));
  const codexConfig = resolve(process.env.CODEX_CONFIG_PATH || join(codexHome, "config.toml"));
  const claudeSettings = resolve(
    process.env.CLAUDE_SETTINGS_PATH || join(home, ".claude/settings.json"),
  );
  const configPath = resolve(
    process.env.LLM_GATEWAY_CONFIG || join(home, ".config/dotfiles/llm-gateway.json"),
  );
  const statePath = join(home, ".config/dotfiles/llm-gateway-state.json");
  const credentialTarget = join(home, ".local/libexec/dotfiles/llm-gateway-credential");
  const codexGatewaiTarget = join(home, ".local/libexec/dotfiles/codex-gatewai");
  const grokHome = join(home, ".grok");
  const grokConfig = join(grokHome, "config.toml");
  const grokAuth = join(grokHome, "auth.json");
  const codexBackupPath = `${codexConfig}.llm-gateway.backup`;
  const claudeBackupPath = `${claudeSettings}.llm-gateway.backup`;
  const grokConfigBackupPath = `${grokConfig}.llm-gateway.backup`;
  const grokAuthBackupPath = `${grokAuth}.llm-gateway.backup`;

  if (mode === "rollback") {
    if (!existsSync(statePath)) {
      process.stdout.write("LLM gateway is already rolled back\n");
      return;
    }
    const state = readState(statePath);
    if (state.codexConfigExisted) {
      if (!state.codexBackupPath || !existsSync(state.codexBackupPath))
        throw new Error("Codex rollback backup is missing");
      atomicCopy(state.codexBackupPath, codexConfig, 0o600);
    } else {
      rmSync(codexConfig, { force: true });
    }
    if (state.claudeSettingsExisted) {
      if (!state.claudeBackupPath || !existsSync(state.claudeBackupPath))
        throw new Error("Claude rollback backup is missing");
      atomicCopy(state.claudeBackupPath, claudeSettings, 0o600);
    } else {
      rmSync(claudeSettings, { force: true });
    }
    rmSync(credentialTarget, { force: true });
    rmSync(codexGatewaiTarget, { force: true });
    if (state.grokEnabled) restoreGrok(state, grokConfig, grokAuth);
    if (state.codexBackupPath) rmSync(state.codexBackupPath, { force: true });
    if (state.claudeBackupPath) rmSync(state.claudeBackupPath, { force: true });
    rmSync(statePath, { force: true });
    process.stdout.write("rolled back LLM gateway configuration\n");
    return;
  }

  const helpers = await bundleGatewayHelpers();
  const sourceCredential = helpers["llm-gateway-credential"];
  const sourceCodexGatewai = helpers["codex-gatewai"];
  const config = validateLocalInputs(configPath);
  const desiredClaudeSettings = claudeGatewaySettings(
    existsSync(claudeSettings) ? readFileSync(claudeSettings, "utf8") : "",
    config.gatewaiBaseUrl,
    credentialTarget,
  );
  if (mode === "check") {
    if (!existsSync(statePath) || !ownerOnly(statePath))
      throw new Error("LLM gateway state is missing or not owner-only");
    readState(statePath);
    assertInstalledFile(sourceCredential, credentialTarget);
    assertInstalledFile(sourceCodexGatewai, codexGatewaiTarget);
    const overridesProbe = spawnSync(codexGatewaiTarget, ["--gateway-overrides"], {
      encoding: "utf8",
      env: { ...process.env, LLM_GATEWAY_CONFIG: configPath },
    });
    const launcherOverrides = overridesProbe.stdout.trim().split("\n").sort();
    const expectedOverrides = [...codexGatewaiOverrides(config, credentialTarget)].sort();
    if (
      overridesProbe.status !== 0 ||
      JSON.stringify(launcherOverrides) !== JSON.stringify(expectedOverrides)
    ) {
      throw new Error(
        "codex-gatewai launcher overrides drifted from the Codex gateway config edits",
      );
    }
    if (config.grokBin) {
      const currentGrokConfig = existsSync(grokConfig) ? readFileSync(grokConfig, "utf8") : "";
      grokGatewaySettings(currentGrokConfig, config.gatewaiBaseUrl, credentialTarget);
      const blocks = currentGrokConfig.match(grokGatewayPattern);
      const unmarked = currentGrokConfig
        .replace(grokGatewayPattern, "")
        .match(grokUnmarkedGatewayPattern(config.gatewaiBaseUrl, credentialTarget));
      if (
        !(
          (blocks?.length === 1 &&
            !unmarked &&
            blocks[0].trimEnd() === grokGatewayBlock(config.gatewaiBaseUrl, credentialTarget)) ||
          (!blocks && unmarked?.length === 1)
        )
      ) {
        throw new Error("Grok gateway config drifted");
      }
    }
    const contents = readFileSync(codexConfig, "utf8");
    for (const expected of [
      'model_provider = "gatewai"',
      config.gatewaiBaseUrl,
      credentialTarget,
      "[model_providers.gatewai.auth]",
      'X-OpenAI-Actor-Authorization = "local-proxy"',
      'args = ["gatewai"]',
    ]) {
      if (!contents.includes(expected)) throw new Error("Codex gateway config drifted");
    }
    const claude = JSON.parse(readFileSync(claudeSettings, "utf8")) as {
      apiKeyHelper?: unknown;
      env?: Record<string, unknown>;
    };
    if (
      claude.apiKeyHelper !== `${credentialTarget} gatewai` ||
      claude.env?.ANTHROPIC_BASE_URL !== claudeGatewayBaseUrl(config.gatewaiBaseUrl)
    ) {
      throw new Error("Claude gateway settings drifted");
    }
    if (/^\[model_providers\.bifrost[.\]]/m.test(contents))
      throw new Error("Codex gateway config still has the retired Bifrost provider");
    const result = spawnSync(credentialTarget, ["gatewai"], {
      encoding: "utf8",
      env: { ...process.env, LLM_GATEWAY_CONFIG: configPath },
    });
    if (result.status !== 0 || result.stdout.trim().length === 0) {
      const detail = result.error
        ? result.error.message
        : result.stderr.trim() ||
          (result.signal
            ? `killed by ${result.signal}`
            : `exit ${result.status ?? "unknown"} without output`);
      throw new Error(`gatewai credential helper failed: ${detail}`);
    }
    process.stdout.write(
      `ok gatewai config, helpers, resolved credentials, Codex and Claude on Gatewai, Grok=${Boolean(config.grokBin)}\n`,
    );
    return;
  }

  if (existsSync(statePath)) readState(statePath);
  if (!existsSync(statePath)) {
    const codexExisted = existsSync(codexConfig);
    const claudeExisted = existsSync(claudeSettings);
    if (codexExisted && existsSync(codexBackupPath))
      throw new Error(`refusing to overwrite existing backup: ${codexBackupPath}`);
    if (claudeExisted && existsSync(claudeBackupPath))
      throw new Error(`refusing to overwrite existing backup: ${claudeBackupPath}`);
    if (codexExisted) atomicCopy(codexConfig, codexBackupPath, 0o600);
    if (claudeExisted) atomicCopy(claudeSettings, claudeBackupPath, 0o600);
    const grokConfigState = config.grokBin
      ? captureOptionalBackup(grokConfig, grokConfigBackupPath, "Grok config")
      : { existed: false, backupPath: null };
    const grokAuthState = config.grokBin
      ? captureOptionalBackup(grokAuth, grokAuthBackupPath, "Grok auth")
      : { existed: false, backupPath: null };
    atomicWriteJson(statePath, {
      version: 9,
      codexConfigExisted: codexExisted,
      codexBackupPath: codexExisted ? codexBackupPath : null,
      claudeSettingsExisted: claudeExisted,
      claudeBackupPath: claudeExisted ? claudeBackupPath : null,
      grokEnabled: Boolean(config.grokBin),
      grokConfigExisted: grokConfigState.existed,
      grokConfigBackupPath: grokConfigState.backupPath,
      grokAuthExisted: grokAuthState.existed,
      grokAuthBackupPath: grokAuthState.backupPath,
    } satisfies ClientState);
  } else {
    const state = readState(statePath);
    // Grok joins or leaves an existing enrollment in place: a full rollback
    // would also restore the Codex and Claude snapshots and drop everything
    // added to them since enrollment.
    if (!state.grokEnabled && config.grokBin) {
      const grokConfigState = captureOptionalBackup(
        grokConfig,
        grokConfigBackupPath,
        "Grok config",
      );
      const grokAuthState = captureOptionalBackup(grokAuth, grokAuthBackupPath, "Grok auth");
      atomicWriteJson(statePath, {
        ...state,
        grokEnabled: true,
        grokConfigExisted: grokConfigState.existed,
        grokConfigBackupPath: grokConfigState.backupPath,
        grokAuthExisted: grokAuthState.existed,
        grokAuthBackupPath: grokAuthState.backupPath,
      } satisfies ClientState);
    } else if (state.grokEnabled && !config.grokBin) {
      restoreGrok(state, grokConfig, grokAuth);
      atomicWriteJson(statePath, {
        ...state,
        grokEnabled: false,
        grokConfigExisted: false,
        grokConfigBackupPath: null,
        grokAuthExisted: false,
        grokAuthBackupPath: null,
      } satisfies ClientState);
    }
  }

  atomicWriteJson(configPath, config);
  atomicWriteJson(statePath, readState(statePath));
  atomicWriteText(credentialTarget, sourceCredential, 0o700);
  atomicWriteText(codexGatewaiTarget, sourceCodexGatewai, 0o700);
  if (config.grokBin) {
    const currentGrokConfig = existsSync(grokConfig) ? readFileSync(grokConfig, "utf8") : "";
    atomicWriteText(
      grokConfig,
      grokGatewaySettings(currentGrokConfig, config.gatewaiBaseUrl, credentialTarget),
      0o600,
    );
  }
  await writeConfigEdits(gatewayEdits(config, credentialTarget));
  chmodSync(codexConfig, 0o600);
  atomicWriteJson(claudeSettings, desiredClaudeSettings);
  process.stdout.write(
    `configured Codex and Claude gateway routing${config.grokBin ? " plus canonical Grok gateway routing" : ""}\n`,
  );
}
