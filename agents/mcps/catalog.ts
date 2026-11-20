import { isAbsolute, join } from "node:path";
import { Schema } from "effect";

import type { AgentLayer } from "../../profiles/model.ts";
import { ClosedStruct, decodeOr, decodeOrThrow, readJsonFile } from "../decode.ts";
import { composeLayers, ManifestHarnesses, SafeName } from "../harness.ts";
import { readLocalOverlay } from "../local.ts";

const CLIENT_ID_MESSAGE = "oauth clientId must match [A-Za-z0-9._-]+";
const CALLBACK_PORT_MESSAGE = "oauth callbackPort must be an integer from 1024 to 65535";

const McpOAuth = ClosedStruct(
  {
    clientId: Schema.String.annotate({ message: CLIENT_ID_MESSAGE })
      .check(Schema.isPattern(/^[A-Za-z0-9._-]+$/, { message: CLIENT_ID_MESSAGE }))
      .annotateKey({ messageMissingKey: CLIENT_ID_MESSAGE }),
    callbackPort: Schema.Number.annotate({ message: CALLBACK_PORT_MESSAGE })
      .check(
        Schema.isInt({ message: CALLBACK_PORT_MESSAGE }),
        Schema.isBetween({ minimum: 1024, maximum: 65_535 }, { message: CALLBACK_PORT_MESSAGE }),
      )
      .annotateKey({ messageMissingKey: CALLBACK_PORT_MESSAGE }),
  },
  {
    notObject: "oauth must be an object with clientId and callbackPort",
    unsupported: (keys) => `oauth has unsupported keys ${keys}`,
  },
);
export type McpOAuth = typeof McpOAuth.Type;

const HEADERS_HELPER_MESSAGE = "headersHelper must be an absolute or ~/ path without whitespace";

const McpIdentity = Schema.Struct({ name: SafeName, url: Schema.String });

const Mcp = Schema.Struct({
  name: SafeName,
  url: Schema.String.check(
    Schema.makeFilter((url: string) => URL.canParse(url), { message: "url is not a URL" }),
    Schema.makeFilter((url: string) => new URL(url).protocol === "https:", {
      message: "url must use https",
    }),
  ),
  harnesses: ManifestHarnesses,
  headersHelper: Schema.optionalKey(
    Schema.String.annotate({ message: HEADERS_HELPER_MESSAGE }).check(
      Schema.makeFilter(
        (path: string) => (isAbsolute(path) || path.startsWith("~/")) && !/\s/.test(path),
        { message: HEADERS_HELPER_MESSAGE },
      ),
    ),
  ),
  oauth: Schema.optionalKey(McpOAuth),
}).check(
  Schema.makeFilter(
    (mcp) =>
      mcp.headersHelper === undefined ||
      (mcp.harnesses.length === 1 && mcp.harnesses[0] === "claude"),
    { message: 'headersHelper needs harnesses ["claude"]; Codex cannot run it' },
  ),
  Schema.makeFilter((mcp) => mcp.oauth === undefined || mcp.headersHelper === undefined, {
    message: "cannot set both oauth and headersHelper",
  }),
);
export type Mcp = typeof Mcp.Type;

const McpManifest = Schema.Struct({ mcps: Schema.Unknown });

export function expandHeadersHelper(path: string, home: string | undefined): string {
  if (!path.startsWith("~/")) {
    return path;
  }
  if (home === undefined || home.length === 0) {
    throw new Error(`Cannot expand headers helper ${path}: HOME is not set`);
  }
  return join(home, path.slice(2));
}

function readMcp(value: unknown, manifestPath: string): Mcp {
  const label = `Invalid MCP manifest at ${manifestPath}`;
  const { name } = decodeOr(McpIdentity, value, `${label}: expected safe MCP name and url strings`);
  return decodeOrThrow(Mcp, value, (detail) => `${label}: ${name} ${detail}`);
}

function parseMcps(value: unknown, manifestPath: string): Mcp[] {
  const entries = decodeOr(
    Schema.Array(Schema.Unknown),
    value,
    `Invalid MCP manifest at ${manifestPath}: expected an mcps array`,
  );
  const mcps = entries.map((mcp) => readMcp(mcp, manifestPath));
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
  const label = `Invalid MCP manifest at ${manifestPath}`;
  const { mcps } = decodeOr(
    McpManifest,
    readJsonFile(manifestPath, label),
    `${label}: expected an mcps array`,
  );
  return parseMcps(mcps, manifestPath);
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
