import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { type McpOAuth } from "./catalog.ts";

export function codexCallbackUrl(oauth: McpOAuth): string {
  return `http://localhost:${oauth.callbackPort}/callback`;
}

function configuredOAuth(env: NodeJS.ProcessEnv, name: string): unknown {
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : undefined);
  if (home === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(join(home, "config.toml"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("mcp_servers" in parsed)) {
    return undefined;
  }
  const servers = parsed.mcp_servers;
  if (typeof servers !== "object" || servers === null || !Object.hasOwn(servers, name)) {
    return undefined;
  }
  const entry: unknown = Object.getOwnPropertyDescriptor(servers, name)?.value;
  return typeof entry === "object" && entry !== null && "oauth" in entry ? entry.oauth : undefined;
}

export function codexOAuthMatches(
  env: NodeJS.ProcessEnv,
  name: string,
  oauth: McpOAuth | undefined,
): boolean {
  const configured = configuredOAuth(env, name);
  if (oauth === undefined) {
    return typeof configured !== "object" || configured === null || !("client_id" in configured);
  }
  if (
    typeof configured !== "object" ||
    configured === null ||
    !("client_id" in configured) ||
    configured.client_id !== oauth.clientId ||
    !("callback_url" in configured) ||
    typeof configured.callback_url !== "string"
  ) {
    return false;
  }
  try {
    const callback = new URL(configured.callback_url);
    const expected = new URL(codexCallbackUrl(oauth));
    return (
      callback.protocol === expected.protocol &&
      callback.hostname === expected.hostname &&
      callback.port === expected.port
    );
  } catch {
    return false;
  }
}
