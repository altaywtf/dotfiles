import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type AgentLayer } from "../../profiles/model.ts";
import { composeLayers, type Harness, HARNESSES, isSafeName, readHarnesses } from "../harness.ts";
import { readLocalOverlay } from "../local.ts";
import { errorMessage } from "../runtime.ts";

export type McpServer = {
  name: string;
  url: string;
  harnesses: readonly Harness[];
};

function readManifestHarnesses(value: unknown, path: string, name: string): readonly Harness[] {
  if (value === undefined) {
    return HARNESSES;
  }
  return readHarnesses(
    value,
    `Invalid MCP manifest at ${path}: ${name} harnesses must be a unique non-empty subset of ${HARNESSES.join(", ")}`,
  );
}

function readServer(value: unknown, manifestPath: string): McpServer {
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
      `Invalid MCP manifest at ${manifestPath}: expected safe server name and url strings`,
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

  return { name: value.name, url: value.url, harnesses };
}

function parseServers(value: unknown, manifestPath: string): McpServer[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: expected a servers array`);
  }

  const servers = value.map((server) => readServer(server, manifestPath));
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new Error(
        `Invalid MCP manifest at ${manifestPath}: ${server.name} is defined more than once`,
      );
    }
    names.add(server.name);
  }
  return servers;
}

export function readServers(manifestPath: string): McpServer[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: ${errorMessage(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || !("servers" in parsed)) {
    throw new Error(`Invalid MCP manifest at ${manifestPath}: expected a servers array`);
  }
  return parseServers(parsed.servers, manifestPath);
}

export type McpLayer = AgentLayer | "local";

export function readLayeredServers(
  repoDir: string,
  profile: string,
  layers: readonly AgentLayer[],
): {
  layers: readonly McpLayer[];
  servers: McpServer[];
  localPath?: string;
  localNames?: string[];
} {
  if (layers.length === 0) {
    throw new Error(`Profile ${profile} does not manage MCP servers`);
  }

  const manifests = new Map<McpLayer, McpServer[]>();
  for (const layer of ["developer", "workstation", "devbox", "personal"] as const) {
    manifests.set(layer, readServers(join(repoDir, "agents", "mcps", `${layer}.json`)));
  }

  const selected: McpLayer[] = [...layers];
  const local = readLocalOverlay(repoDir);
  if (local?.document.servers !== undefined) {
    manifests.set("local", parseServers(local.document.servers, local.path));
    selected.push("local");
  }

  const servers = composeLayers(
    selected,
    manifests,
    (server) => server.name,
    (name) => `Invalid layered MCP servers: ${name} is defined more than once`,
  );
  return selected.includes("local") && local
    ? {
        layers: selected,
        servers,
        localPath: local.path,
        localNames: (manifests.get("local") ?? []).map((server) => server.name),
      }
    : { layers: selected, servers };
}
