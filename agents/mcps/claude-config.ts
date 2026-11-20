import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type McpOAuth } from "./catalog.ts";

function claudeConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR || env.HOME;
  return dir ? join(dir, ".claude.json") : undefined;
}

function userEntry(env: NodeJS.ProcessEnv, name: string): object | undefined {
  const path = claudeConfigPath(env);
  if (path === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) return undefined;
  const servers = parsed.mcpServers;
  if (typeof servers !== "object" || servers === null || !Object.hasOwn(servers, name)) {
    return undefined;
  }
  const entry: unknown = Object.getOwnPropertyDescriptor(servers, name)?.value;
  return typeof entry === "object" && entry !== null ? entry : undefined;
}

export function claudeAuthMatches(
  env: NodeJS.ProcessEnv,
  name: string,
  headersHelper: string | undefined,
  oauth: McpOAuth | undefined,
): boolean {
  const entry = userEntry(env, name);
  const configuredHelper =
    entry !== undefined && "headersHelper" in entry && typeof entry.headersHelper === "string"
      ? entry.headersHelper
      : undefined;
  if (configuredHelper !== headersHelper) return false;

  const configuredOAuth: unknown =
    entry !== undefined && "oauth" in entry ? entry.oauth : undefined;
  if (oauth === undefined) return configuredOAuth === undefined;
  return (
    typeof configuredOAuth === "object" &&
    configuredOAuth !== null &&
    Object.keys(configuredOAuth).length === 2 &&
    "clientId" in configuredOAuth &&
    configuredOAuth.clientId === oauth.clientId &&
    "callbackPort" in configuredOAuth &&
    configuredOAuth.callbackPort === oauth.callbackPort
  );
}
