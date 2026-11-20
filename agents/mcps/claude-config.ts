import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";

import type { McpOAuth } from "./catalog.ts";

const ClaudeConfig = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
);

const ClaudeServer = Schema.Struct({
  headersHelper: Schema.optionalKey(Schema.Unknown),
  oauth: Schema.optionalKey(Schema.Unknown),
});

const ClaudeOAuth = Schema.Struct({ clientId: Schema.String, callbackPort: Schema.Number });

function claudeConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR || env.HOME;
  return dir ? join(dir, ".claude.json") : undefined;
}

function userEntry(env: NodeJS.ProcessEnv, name: string): typeof ClaudeServer.Type | undefined {
  const path = claudeConfigPath(env);
  if (path === undefined) return undefined;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return Schema.decodeUnknownOption(ClaudeConfig)(contents).pipe(
    Option.filter(({ mcpServers }) => Object.hasOwn(mcpServers, name)),
    Option.flatMap(({ mcpServers }) => Schema.decodeUnknownOption(ClaudeServer)(mcpServers[name])),
    Option.getOrUndefined,
  );
}

export function claudeAuthMatches(
  env: NodeJS.ProcessEnv,
  name: string,
  headersHelper: string | undefined,
  oauth: McpOAuth | undefined,
): boolean {
  const entry = userEntry(env, name);
  const configuredHelper = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.String)(entry?.headersHelper),
  );
  if (configuredHelper !== headersHelper) return false;

  if (oauth === undefined) return entry?.oauth === undefined;
  return Schema.decodeUnknownOption(ClaudeOAuth, { onExcessProperty: "error" })(entry?.oauth).pipe(
    Option.exists(
      (configured) =>
        configured.clientId === oauth.clientId && configured.callbackPort === oauth.callbackPort,
    ),
  );
}
