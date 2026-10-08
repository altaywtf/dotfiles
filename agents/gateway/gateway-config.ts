import { Schema } from "effect";
import { isAbsolute } from "node:path";
import type { ConfigEdit } from "../codex/config.ts";

const AbsolutePath = Schema.NonEmptyString.pipe(Schema.check(Schema.makeFilter(isAbsolute)));
// Retired Bifrost fields stay readable so maintenance can drop them from
// existing enrollments; they never reach a client.
const GatewayShape = Schema.Struct({
  version: Schema.Literal(3),
  credentials: Schema.Struct({
    gatewai: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,}$/))),
    bifrost: Schema.optionalKey(Schema.String),
  }),
  gatewaiBaseUrl: Schema.NonEmptyString,
  bifrostBaseUrl: Schema.optionalKey(Schema.String),
  grokBin: Schema.optionalKey(AbsolutePath),
});
const GatewayUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((input) => {
      try {
        const url = new URL(input);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname.endsWith("/v1")
        );
      } catch {
        return false;
      }
    }),
  ),
);
export type GatewayConfig = {
  version: 3;
  credentials: { gatewai: string };
  gatewaiBaseUrl: string;
  grokBin?: string;
};

export function parseGatewayConfig(contents: string): GatewayConfig {
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    throw new Error("gateway config must contain valid JSON");
  }
  let value: typeof GatewayShape.Type;
  try {
    value = Schema.decodeUnknownSync(GatewayShape, { onExcessProperty: "error" })(input);
  } catch {
    throw new Error("gateway config contains an unknown field or invalid value");
  }
  if (!Schema.is(GatewayUrl)(value.gatewaiBaseUrl))
    throw new Error(
      "gatewaiBaseUrl must be an HTTPS /v1 URL without credentials, query, or fragment",
    );
  return {
    version: value.version,
    credentials: { gatewai: value.credentials.gatewai },
    gatewaiBaseUrl: value.gatewaiBaseUrl,
    ...(value.grokBin ? { grokBin: value.grokBin } : {}),
  };
}

export function gatewayEdits(config: GatewayConfig, credentialPath: string): ConfigEdit[] {
  return [
    { keyPath: "model_provider", value: "gatewai", mergeStrategy: "upsert" },
    { keyPath: "features.apps", value: false, mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.name", value: "Gatewai", mergeStrategy: "upsert" },
    {
      keyPath: "model_providers.gatewai.base_url",
      value: config.gatewaiBaseUrl,
      mergeStrategy: "upsert",
    },
    { keyPath: "model_providers.gatewai.wire_api", value: "responses", mergeStrategy: "upsert" },
    {
      keyPath: "model_providers.gatewai.requires_openai_auth",
      value: false,
      mergeStrategy: "upsert",
    },
    {
      keyPath: "model_providers.gatewai.supports_websockets",
      value: true,
      mergeStrategy: "upsert",
    },
    {
      keyPath: "model_providers.gatewai.http_headers",
      value: { "X-OpenAI-Actor-Authorization": "local-proxy" },
      mergeStrategy: "upsert",
    },
    {
      keyPath: "model_providers.gatewai.auth.command",
      value: credentialPath,
      mergeStrategy: "upsert",
    },
    { keyPath: "model_providers.gatewai.auth.args", value: ["gatewai"], mergeStrategy: "upsert" },
    { keyPath: "model_providers.gatewai.auth.timeout_ms", value: 5000, mergeStrategy: "upsert" },
    {
      keyPath: "model_providers.gatewai.auth.refresh_interval_ms",
      value: 0,
      mergeStrategy: "upsert",
    },
    { keyPath: "model_providers.bifrost", value: null, mergeStrategy: "replace" },
  ];
}

export function codexGatewaiOverrides(config: GatewayConfig, credentialPath: string): string[] {
  // Codex parses -c values as TOML, so objects must be inline tables
  // ({"k" = "v"}), not JSON ({"k":"v"}); JSON syntax degrades to a string.
  const serialize = (value: ConfigEdit["value"]): string => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value).map(
        ([key, entry]) => `${JSON.stringify(key)} = ${JSON.stringify(entry)}`,
      );
      return `{${entries.join(", ")}}`;
    }
    return JSON.stringify(value);
  };
  return gatewayEdits(config, credentialPath)
    .filter(
      (edit) =>
        edit.keyPath === "model_provider" || edit.keyPath.startsWith("model_providers.gatewai."),
    )
    .map((edit) => `${edit.keyPath}=${serialize(edit.value)}`);
}
