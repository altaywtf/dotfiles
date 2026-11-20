import type { CommandResult } from "./runtime.ts";

export type AuditFormat = "text" | "json";
export type FindingSeverity = "ok" | "warn" | "fail";

type Finding = { severity: FindingSeverity; message: string };

type AuditSummary<Name extends string, Fields extends object> = AuditBaseSummary & {
  audit: Name;
} & Fields;

type AuditResult<Name extends string, Fields extends object> = {
  status: number;
  summary: AuditSummary<Name, Fields>;
};

export class AuditReport {
  readonly findings: Finding[] = [];
  readonly format: AuditFormat;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;

  constructor(
    format: AuditFormat,
    stdout: (value: string) => void,
    stderr: (value: string) => void,
  ) {
    this.format = format;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  section(title: string): void {
    if (this.format === "text") {
      this.stdout(`\n## ${title}\n`);
    }
  }

  finding(severity: FindingSeverity, message: string): void {
    this.findings.push({ severity, message });
    if (this.format === "json") {
      return;
    }
    const line = `${severity === "fail" ? "FAILED:" : severity} ${message}\n`;
    (severity === "ok" ? this.stdout : this.stderr)(line);
  }

  ok(message: string): void {
    this.finding("ok", message);
  }

  warn(message: string): void {
    this.finding("warn", message);
  }

  fail(message: string): void {
    this.finding("fail", message);
  }

  output(result: CommandResult): void {
    if (this.format !== "text") {
      return;
    }
    if (result.stdout) {
      this.stdout(result.stdout);
    }
    if (result.stderr) {
      this.stderr(result.stderr);
    }
  }

  finish<Name extends string, Fields extends object>(
    audit: Name,
    label: string,
    fields: Fields,
  ): AuditResult<Name, Fields> {
    const failed = this.findings.filter(({ severity }) => severity === "fail").length;
    const warnings = this.findings.filter(({ severity }) => severity === "warn").length;
    const status: "pass" | "warn" | "fail" = failed > 0 ? "fail" : warnings > 0 ? "warn" : "pass";
    const summary = {
      audit,
      status,
      failed,
      warnings,
      ...fields,
    };
    if (this.format === "json") {
      this.stdout(`${JSON.stringify(summary)}\n`);
    } else {
      this.stdout(`\n${label}: ${failed} failed, ${warnings} warnings\n`);
    }
    return { status: failed > 0 ? 1 : 0, summary };
  }
}

type AuditBaseSummary = {
  audit: string;
  status: "pass" | "warn" | "fail";
  failed: number;
  warnings: number;
};
