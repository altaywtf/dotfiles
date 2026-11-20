import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { parse as parseToml } from "smol-toml";

import type { McpOAuth } from "./catalog.ts";

const CodexConfig = Schema.Struct({
  mcp_servers: Schema.Record(Schema.String, Schema.Unknown),
});

const CodexServer = Schema.Struct({ oauth: Schema.Unknown });

const CodexClient = Schema.Struct({ client_id: Schema.Unknown });

const CodexOAuth = Schema.Struct({
  client_id: Schema.String,
  callback_url: Schema.URLFromString,
});

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
  return Schema.decodeUnknownOption(CodexConfig)(parsed).pipe(
    Option.filter(({ mcp_servers }) => Object.hasOwn(mcp_servers, name)),
    Option.flatMap(({ mcp_servers }) => Schema.decodeUnknownOption(CodexServer)(mcp_servers[name])),
    Option.map(({ oauth }) => oauth),
    Option.getOrUndefined,
  );
}

export function codexOAuthMatches(
  env: NodeJS.ProcessEnv,
  name: string,
  oauth: McpOAuth | undefined,
): boolean {
  const configured = configuredOAuth(env, name);
  if (oauth === undefined) {
    return !Schema.is(CodexClient)(configured);
  }
  const expected = new URL(codexCallbackUrl(oauth));
  return Schema.decodeUnknownOption(CodexOAuth)(configured).pipe(
    Option.exists(
      ({ client_id, callback_url }) =>
        client_id === oauth.clientId &&
        callback_url.protocol === expected.protocol &&
        callback_url.hostname === expected.hostname &&
        callback_url.port === expected.port,
    ),
  );
}
