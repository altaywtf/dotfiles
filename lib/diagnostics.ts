const MAX_DIAGNOSTIC_LENGTH = 600;
const MAX_DIAGNOSTIC_LINES = 3;

export function sanitizeDiagnostic(stderr: string): string {
  const lines = stderr
    // oxlint-disable-next-line no-control-regex -- Strip ANSI escape sequences before printing diagnostics.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-MAX_DIAGNOSTIC_LINES)
    .map((line) =>
      line
        .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[REDACTED]@")
        .replace(
          /((?:authorization|api[-_ ]?key|password|secret|token)\s*[=:]\s*).+$/gi,
          "$1[REDACTED]",
        )
        .replace(
          /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
          "[REDACTED]",
        ),
    );
  const diagnostic = lines.join("\n");
  if (diagnostic.length <= MAX_DIAGNOSTIC_LENGTH) {
    return diagnostic;
  }
  return `${diagnostic.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}
