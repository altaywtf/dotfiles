import { readFileSync } from "node:fs";
import { Schema } from "effect";

const Location = Schema.Struct({
  commit: Schema.String,
  file: Schema.String,
  line: Schema.Number,
  detector: Schema.String,
});
const Allowlist = Schema.Struct({
  version: Schema.Literal(1),
  findings: Schema.Array(Schema.Struct({ ...Location.fields, reason: Schema.NonEmptyString })),
});
const Finding = Schema.Struct({
  DetectorName: Schema.String,
  Verified: Schema.Boolean,
  SourceMetadata: Schema.Struct({
    Data: Schema.Struct({
      Git: Schema.Struct({ commit: Schema.String, file: Schema.String, line: Schema.Number }),
    }),
  }),
});

export type TrufflehogFindings = { allowed: number; unexpected: string[] };

// History cannot be rewritten to drop a reviewed fixture, so known findings are
// pinned by commit and line. A verified secret is never allowed.
export function classifyTrufflehogFindings(
  stdout: string,
  allowlistPath: string,
): TrufflehogFindings {
  const allowlist = Schema.decodeUnknownSync(Allowlist)(
    JSON.parse(readFileSync(allowlistPath, "utf8")),
  );
  const result: TrufflehogFindings = { allowed: 0, unexpected: [] };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const finding = Schema.decodeUnknownSync(Finding)(JSON.parse(line));
    const { commit, file, line: number } = finding.SourceMetadata.Data.Git;
    const allowed =
      !finding.Verified &&
      allowlist.findings.some(
        (entry) =>
          entry.commit === commit &&
          entry.file === file &&
          entry.line === number &&
          entry.detector === finding.DetectorName,
      );
    if (allowed) result.allowed += 1;
    else
      result.unexpected.push(
        `${finding.DetectorName}${finding.Verified ? " (verified)" : ""} ${file}:${number} in ${commit.slice(0, 12)}`,
      );
  }
  return result;
}
