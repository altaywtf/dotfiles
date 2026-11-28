import { readFileSync, realpathSync } from "node:fs";
import { Option, Schema } from "effect";
import { isAbsolute, relative, resolve } from "node:path";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const Severity = Schema.Literals(["low", "medium", "high", "critical"]);

type Severity = typeof Severity.Type;

const PolicyHeader = Schema.Struct({
  version: Schema.Literal(1),
  defaultSeverity: Severity,
  failureThreshold: Severity,
});

const Findings = Schema.Array(JsonObject);

type RuleCounts = Record<string, number>;

export type FindingSummary = {
  findingCount: number;
  failures: number;
  warnings: number;
  rules: RuleCounts;
  severities: RuleCounts;
};

const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const decodeJsonFindings = Schema.decodeUnknownOption(Schema.fromJsonString(Findings));
const decodePolicyHeader = Schema.decodeUnknownOption(PolicyHeader);
const decodeJsonObjectValue = Schema.decodeUnknownOption(JsonObject);
const isSeverity = Schema.is(Severity);
const isCount = Schema.is(Schema.Natural);

type Policy = {
  defaultSeverity: Severity;
  failureThreshold: Severity;
  rules: Record<string, Severity>;
};

function readPolicy(path: string): Policy {
  const policy = Option.getOrThrowWith(
    decodeJsonObject(readFileSync(path, "utf8")),
    () => new Error("invalid Gitleaks policy"),
  );

  const header = Option.getOrThrowWith(
    decodePolicyHeader(policy),
    () => new Error("invalid Gitleaks policy header"),
  );

  const ruleEntries = Option.getOrThrowWith(
    decodeJsonObjectValue(policy.rules),
    () => new Error("invalid Gitleaks policy rules"),
  );

  const rules: Record<string, Severity> = {};

  for (const [rule, severity] of Object.entries(ruleEntries)) {
    if (!isSeverity(severity)) {
      throw new Error(`invalid severity for ${rule}`);
    }

    rules[rule] = severity;
  }

  return {
    defaultSeverity: header.defaultSeverity,
    failureThreshold: header.failureThreshold,
    rules,
  };
}

function readFindings(path: string): typeof Findings.Type {
  let contents: string;

  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error("Gitleaks report is missing or invalid");
  }

  return Option.getOrThrowWith(
    decodeJsonFindings(contents),
    () => new Error("Gitleaks report is missing or invalid"),
  );
}

const realPath = Option.liftThrowable((path: string) => realpathSync(path));

function rootVariants(root: string): Array<string> {
  const roots = new Set([resolve(root), ...Option.toArray(realPath(root))]);

  for (const candidate of roots) {
    if (candidate.startsWith("/private/")) {
      roots.add(candidate.slice(8));
    } else if (candidate.startsWith("/var/")) {
      roots.add(`/private${candidate}`);
    }
  }

  return [...roots];
}

function safeRelative(root: string, locator: string): string {
  if (!locator || !isAbsolute(locator)) {
    return "unknown";
  }

  for (const candidate of rootVariants(root)) {
    const path = relative(candidate, locator);

    if (path && path !== ".." && !path.startsWith("../") && !path.startsWith("/")) {
      return path;
    }
  }

  return "unknown";
}

export function findingLocators(scanRoot: string, reportPath: string): Array<string> {
  return readFindings(reportPath).map((finding) => {
    const rule = Schema.is(Schema.NonEmptyString)(finding.RuleID) ? finding.RuleID : "unknown";

    const locator = Schema.is(Schema.NonEmptyString)(finding.SymlinkFile)
      ? finding.SymlinkFile
      : Schema.is(Schema.String)(finding.File)
        ? finding.File
        : "";

    return `${rule}\t${safeRelative(scanRoot, locator)}`;
  });
}

function readRuleCounts(existingJson: string) {
  const parsed = Option.getOrThrowWith(
    decodeJsonObject(existingJson || "{}"),
    () => new Error("invalid persisted count map"),
  );

  const counts: RuleCounts = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!isCount(value)) {
      throw new Error(`invalid count for ${key}`);
    }

    counts[key] = value;
  }

  return counts;
}

export function summarizeFindings(
  existingRulesJson: string,
  existingSeveritiesJson: string,
  reportPath: string,
  policyPath: string,
): FindingSummary {
  const policy = readPolicy(policyPath);
  const findings = readFindings(reportPath);
  const rules = readRuleCounts(existingRulesJson);
  const severities = readRuleCounts(existingSeveritiesJson);
  let failures = 0;
  let warnings = 0;

  for (const finding of findings) {
    const rule = Schema.is(Schema.NonEmptyString)(finding.RuleID) ? finding.RuleID : "unknown";
    const severity = policy.rules[rule] ?? policy.defaultSeverity;
    rules[rule] = (rules[rule] ?? 0) + 1;
    severities[severity] = (severities[severity] ?? 0) + 1;

    if (severityRank[severity] >= severityRank[policy.failureThreshold]) {
      failures += 1;
    } else {
      warnings += 1;
    }
  }

  return {
    findingCount: findings.length,
    failures,
    warnings,
    rules: Object.fromEntries(
      Object.entries(rules).sort(([left], [right]) => left.localeCompare(right)),
    ),
    severities: Object.fromEntries(
      Object.keys(severityRank).flatMap((severity) =>
        severities[severity] === undefined ? [] : [[severity, severities[severity]]],
      ),
    ),
  };
}
