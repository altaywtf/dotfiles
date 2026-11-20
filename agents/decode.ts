import { readFileSync } from "node:fs";
import { Option, Result, Schema, SchemaIssue, SchemaTransformation } from "effect";

import { errorMessage } from "./runtime.ts";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export function decodeOrThrow<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  describe: (detail: string) => string,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema)(input);
  if (Result.isSuccess(result)) return result.success;
  const [issue] = formatIssues(result.failure.issue).issues;
  throw new Error(describe(issue?.message ?? result.failure.message), {
    cause: result.failure,
  });
}

export function decodeOr<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  message: string,
): S["Type"] {
  return Option.getOrThrowWith(Schema.decodeUnknownOption(schema)(input), () => new Error(message));
}

export function readJsonFile(path: string, label: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label}: ${errorMessage(error)}`, { cause: error });
  }
  return decodeOrThrow(
    Schema.fromJsonString(Schema.Unknown),
    contents,
    (detail) => `${label}: ${detail}`,
  );
}

export function ClosedStruct<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  messages: { notObject: string; unsupported: (keys: string) => string },
) {
  const known = new Set(Object.keys(fields));
  return Schema.Record(Schema.String, Schema.Unknown)
    .annotate({ message: messages.notObject })
    .check(
      Schema.makeFilter((input: { readonly [key: string]: unknown }) => {
        const unknownKeys = Object.keys(input).filter((key) => !known.has(key));
        return unknownKeys.length === 0 || messages.unsupported(unknownKeys.join(", "));
      }),
    )
    .pipe(
      Schema.decodeTo(Schema.Struct(fields), SchemaTransformation.passthrough({ strict: false })),
    );
}
