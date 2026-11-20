import {
  chmodSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AuditReport } from "../report.ts";
import type { CommandRunner } from "../runtime.ts";
import { resolveSources, walkFiles } from "../paths.ts";
import type { PathSource } from "../paths.ts";
import { findingLocators, summarizeFindings } from "./findings.ts";

export type SecretScanCounts = {
  scanned: number;
  findings: number;
  rules: Record<string, number>;
  severities: Record<string, number>;
};

function stagePath(scanRoot: string, home: string, path: string): void {
  const relative = path.startsWith(`${home}/`)
    ? `home/${path.slice(home.length + 1)}`
    : path.startsWith("/")
      ? `root/${path.slice(1)}`
      : `relative/${path}`;
  const destination = join(scanRoot, relative);
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(realpathSync(path), destination);
}

export function scanSecrets(
  options: {
    home: string;
    env: NodeJS.ProcessEnv;
    command: CommandRunner;
    sources: ReadonlyArray<PathSource>;
    report: AuditReport;
  },
  counts: SecretScanCounts,
): void {
  const { home, env, command, sources, report } = options;
  for (const tool of ["gitleaks", "trufflehog"] as const) {
    const result = command(tool, ["--version"]);
    if (result.error?.message.includes("ENOENT")) {
      report.finding("fail", `${tool} is missing for local secret scan`);
      return;
    }
  }

  const skipped = (path: string) => report.warn(`audit coverage skipped: ${path}`);
  const paths = [
    ...new Set(
      resolveSources(home, sources, skipped).flatMap((path) =>
        walkFiles(path, Number.POSITIVE_INFINITY, skipped),
      ),
    ),
  ];
  counts.scanned += paths.length;
  if (paths.length === 0) {
    return report.finding("warn", "no readable local config files found for gitleaks secret scan");
  }

  let scanRoot = "";
  let reportRoot = "";
  try {
    const temporaryRoot = env.TMPDIR || tmpdir();
    mkdirSync(temporaryRoot, { recursive: true });
    scanRoot = mkdtempSync(join(temporaryRoot, "dotfiles-secret-scan."));
    reportRoot = mkdtempSync(join(temporaryRoot, "dotfiles-secret-report."));
    const reportPath = join(reportRoot, "gitleaks-report.json");
    chmodSync(scanRoot, 0o700);
    chmodSync(reportRoot, 0o700);
    writeFileSync(reportPath, "", { mode: 0o600 });
    for (const path of paths) {
      stagePath(scanRoot, home, path);
    }

    const gitleaks = command(
      "gitleaks",
      [
        "dir",
        "--follow-symlinks",
        "--redact",
        "--exit-code",
        "183",
        "--no-banner",
        "--log-level",
        "error",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        scanRoot,
      ],
      { timeoutMs: 600_000 },
    );
    const summary = summarizeFindings(
      JSON.stringify(counts.rules),
      JSON.stringify(counts.severities),
      reportPath,
      resolve(import.meta.dirname, "gitleaks-policy.json"),
    );
    counts.findings += summary.findingCount;
    counts.rules = summary.rules;
    counts.severities = summary.severities;

    if (gitleaks.error || (gitleaks.status !== 0 && gitleaks.status !== 183)) {
      report.finding("fail", "gitleaks local config scan did not complete");
    } else if (summary.findingCount === 0 && gitleaks.status === 183) {
      report.finding("fail", "gitleaks reported leaks without usable findings");
    } else if (summary.findingCount > 0 && gitleaks.status === 0) {
      report.finding("fail", "gitleaks exit status disagrees with its report");
    }

    if (summary.findingCount === 0 && gitleaks.status === 0 && !gitleaks.error) {
      report.finding("ok", `gitleaks found no leaks in ${paths.length} local config files`);
    } else if (summary.findingCount > 0) {
      if (report.format === "text") {
        for (const locator of findingLocators(scanRoot, reportPath)) {
          const [rule, path] = locator.split("\t", 2);
          report.stderr(`finding rule=${rule} path=${path}\n`);
        }
      }
      report.finding(
        summary.failures > 0 ? "fail" : "warn",
        summary.failures > 0
          ? "gitleaks reported findings at or above the failure threshold"
          : "gitleaks reported findings below the failure threshold",
      );
    } else {
      report.finding("fail", "gitleaks local config scan failed");
    }

    const trufflehog = command(
      "trufflehog",
      [
        "filesystem",
        "--no-update",
        "--no-color",
        "--results=verified",
        "--fail",
        "--force-skip-binaries",
        "--force-skip-archives",
        "--max-symlink-depth=1",
        scanRoot,
      ],
      { output: "discard", timeoutMs: 600_000 },
    );
    if (trufflehog.status === 0 && !trufflehog.error) {
      report.finding(
        "ok",
        `trufflehog found no verified leaks in ${paths.length} local config files`,
      );
    } else if (trufflehog.status === 183) {
      report.finding("fail", "trufflehog reported verified leaks in local config files");
    } else {
      report.finding("fail", "trufflehog local config scan failed");
    }
  } catch {
    report.finding("fail", "local secret scan could not stage or classify files safely");
  } finally {
    if (scanRoot) {
      rmSync(scanRoot, { recursive: true, force: true });
    }
    if (reportRoot) {
      rmSync(reportRoot, { recursive: true, force: true });
    }
  }
}
