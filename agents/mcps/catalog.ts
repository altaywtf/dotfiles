import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { type AgentLayer } from "../../profiles/model.ts";
import { composeLayers, type Harness, HARNESSES, isSafeName, readHarnesses } from "../harness.ts";
import { readLocalOverlay } from "../local.ts";
import { errorMessage } from "../runtime.ts";

export type Mcp = {
  name: string;
  url: string;
  harnesses: readonly Harness[];
  headersHelper?: string;
  oauth?: McpOAuth;
};

export type McpOAuth = { clientId: string; callbackPort: number };

function readOAuth(value: unknown, path: string, name: string): McpOAuth | undefined {
  if (value === undefined) return undefined;
  const invalid = (detail: string) =>
    new Error(`Invalid MCP manifest at ${path}: ${name} oauth ${detail}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("must be an object with clientId and callbackPort");
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== "clientId" && key !== "callbackPort",
  );
  if (unknownKeys.length > 0) {
    throw invalid(`has unsupported keys ${unknownKeys.join(", ")}`);
  }
  const clientId = "clientId" in value ? value.clientId : undefined;
  if (typeof clientId !== "string" || !/^[A-Za-z0-9._-]+$/.test(clientId)) {
    throw invalid("clientId must match [A-Za-z0-9._-]+");
  }
  const callbackPort = "callbackPort" in value ? value.callbackPort : undefined;
  if (
    typeof callbackPort !== "number" ||
    !Number.isInteger(callbackPort) ||
    callbackPort < 1024 ||
    callbackPort > 65535
  ) {
    throw invalid("callbackPort must be an integer from 1024 to 65535");
  }
  return { clientId, callbackPort };
}

export function expandHeadersHelper(path: string, home: string | undefined): string {
  if (!path.startsWith("~/")) return path;
  if (home === undefined || home.length === 0) {
    throw new Error(`Cannot expand headers helper ${path}: HOME is not set`);
  }
  return join(home, path.slice(2));
}

function readHeadersHelper(
  value: unknown,
  harnesses: readonly Harness[],
  path: string,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !(isAbsolute(value) || value.startsWith("~/")) ||
    /\s/.test(value)
  ) {
    throw new Error(
      `Invalid MCP manifest at ${path}: ${name} headersHelper must be an absolute or ~/ path without whitespace`,
    );
  }
  if (harnesses.length !== 1 || harnesses[0] !== "claude") {
    throw new Error(
      `Invalid MCP manifest at ${path}: ${name} headersHelper needs harnesses ["claude"]; Codex cannot run it`,
    );
  }
  return value;
}

function readManifestHarnesses(value: unknown, path: string, name: string): readonly Harness[] {
  if (value === undefined) {
    return HARNESSES;
  }
  return readHarnesses(
    value,
    `Invalid MCP manifest at ${path}: ${name} harnesses must be a unique non-empty subset of ${HARNESSES.join(", ")}`,
  );
}

function readMcp(value: unknown, manifestPath: string): Mcp {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !isSafeName(value.name) ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw new Error(
      `Invalid MCP manifest at ${manifestPath}: expected safe MCP name and url strings`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: ${value.name} url is not a URL`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: ${value.name} url must use https`);
  }

  const harnesses = readManifestHarnesses(
    "harnesses" in value ? value.harnesses : undefined,
    manifestPath,
    value.name,
  );

  const headersHelper = readHeadersHelper(
    "headersHelper" in value ? value.headersHelper : undefined,
    harnesses,
    manifestPath,
    value.name,
  );

  const oauth = readOAuth("oauth" in value ? value.oauth : undefined, manifestPath, value.name);
  if (oauth !== undefined && headersHelper !== undefined) {
    throw new Error(
      `Invalid MCP manifest at ${manifestPath}: ${value.name} cannot set both oauth and headersHelper`,
    );
  }

  return {
    name: value.name,
    url: value.url,
    harnesses,
    ...(headersHelper === undefined ? {} : { headersHelper }),
    ...(oauth === undefined ? {} : { oauth }),
  };
}

function parseMcps(value: unknown, manifestPath: string): Mcp[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: expected an mcps array`);
  }

  const mcps = value.map((mcp) => readMcp(mcp, manifestPath));
  const names = new Set<string>();
  for (const mcp of mcps) {
    if (names.has(mcp.name)) {
      throw new Error(
        `Invalid MCP manifest at ${manifestPath}: ${mcp.name} is defined more than once`,
      );
    }
    names.add(mcp.name);
  }
  return mcps;
}

export function readMcps(manifestPath: string): Mcp[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || !("mcps" in parsed)) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: expected an mcps array`);
  }
  return parseMcps(parsed.mcps, manifestPath);
}

export type McpLayer = AgentLayer | "local";

export function readLayeredMcps(
  repoDir: string,
  profile: string,
  layers: readonly AgentLayer[],
): {
  layers: readonly McpLayer[];
  mcps: Mcp[];
  localPath?: string;
  localNames?: string[];
} {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage MCPs`);
  }

  const manifests = new Map<McpLayer, Mcp[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    manifests.set(layer, readMcps(join(repoDir, "agents", "mcps", `${layer}.json`)));
  }

  const selected: McpLayer[] = [...layers];
  const local = readLocalOverlay(repoDir);
  if (local?.document.mcps !== undefined) {
    manifests.set("local", parseMcps(local.document.mcps, local.path));
    selected.push("local");
  }

  const mcps = composeLayers(
    selected,
    manifests,
    (mcp) => mcp.name,
    (name) => `Invalid layered MCPs: ${name} is defined more than once`,
  );
  return selected.includes("local") && local
    ? {
        layers: selected,
        mcps,
        localPath: local.path,
        localNames: (manifests.get("local") ?? []).map((mcp) => mcp.name),
      }
    : { layers: selected, mcps };
}
