import { readFileSync } from "node:fs";
import { join } from "node:path";

function claudeConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR || env.HOME;
  return dir ? join(dir, ".claude.json") : undefined;
}

// `claude mcp get` does not print headersHelper, so read the user-scope entry.
export function configuredHeadersHelper(env: NodeJS.ProcessEnv, name: string): string | undefined {
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
  return typeof entry === "object" &&
    entry !== null &&
    "headersHelper" in entry &&
    typeof entry.headersHelper === "string"
    ? entry.headersHelper
    : undefined;
}
