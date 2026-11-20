import { Effect, FileSystem, Option } from "effect";
import { fail } from "../program.ts";

const component = /^[A-Za-z0-9._-]+$/;

export function resolveLaunchdNamespace(requested = ""): string {
  const namespace = requested || process.env.DOTFILES_LAUNCHD_NAMESPACE || "local.dotfiles";
  if (
    !component.test(namespace) ||
    namespace.startsWith(".") ||
    namespace.endsWith(".") ||
    namespace.includes("..")
  ) {
    throw new Error(
      "LaunchDaemon namespace must contain dot-separated letters, numbers, hyphens, or underscores",
    );
  }
  return namespace;
}

export function launchdLabel(service: string, user: string, namespace = ""): string {
  if (!service || !component.test(service)) {
    throw new Error("invalid LaunchDaemon service");
  }
  if (!user || !component.test(user)) {
    throw new Error("invalid LaunchDaemon user");
  }
  return `${resolveLaunchdNamespace(namespace)}.${service}.${user}`;
}

export const resolveLaunchdNamespaceContract = Effect.fn("resolveLaunchdNamespaceContract")(
  function* (requested: string, namespaceFile: string, expectedUid?: number) {
    let requestedNamespace = "";
    if (requested) {
      requestedNamespace = yield* Effect.try({
        try: () => resolveLaunchdNamespace(requested),
        catch: (error) => error,
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(namespaceFile);
    const link = yield* fs.readLink(namespaceFile).pipe(Effect.option);
    if (exists || Option.isSome(link)) {
      if (Option.isSome(link)) {
        return yield* fail(`unsafe stored LaunchDaemon namespace: ${namespaceFile}`);
      }
      const info = yield* fs.stat(namespaceFile);
      if (info.type !== "File" || (info.mode & 0o777) !== 0o600) {
        return yield* fail(`unsafe stored LaunchDaemon namespace: ${namespaceFile}`);
      }
      if (expectedUid !== undefined && Option.getOrUndefined(info.uid) !== expectedUid) {
        return yield* fail(`unsafe stored LaunchDaemon namespace owner: ${namespaceFile}`);
      }
      const contents = yield* fs.readFileString(namespaceFile);
      if (!/^[^\r\n]+(?:\r?\n)?$/.test(contents)) {
        return yield* fail(`invalid stored LaunchDaemon namespace: ${namespaceFile}`);
      }
      const stored = yield* Effect.try({
        try: () => resolveLaunchdNamespace(contents.trim()),
        catch: (error) => error,
      });
      if (requestedNamespace && requestedNamespace !== stored) {
        return yield* fail("LaunchDaemon namespace differs from the stored host contract", 3);
      }
      return stored;
    }
    return yield* Effect.try({
      try: () => resolveLaunchdNamespace(requestedNamespace),
      catch: (error) => error,
    });
  },
);

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const item = (key: string, value: string) =>
  `    <key>${key}</key>\n    <string>${escape(value)}</string>`;

export function plistXml(options: {
  label: string;
  user: string;
  group: string;
  workingDirectory: string;
  stdout: string;
  stderr: string;
  arguments: ReadonlyArray<string>;
  keepAlive?: boolean;
  processType?: string;
  environment?: Readonly<Record<string, string>>;
  calendar?: ReadonlyArray<{ hour: number; minute: number }>;
}): string {
  const args = options.arguments
    .map((argument) => `      <string>${escape(argument)}</string>`)
    .join("\n");
  const environment = options.environment
    ? `\n    <key>EnvironmentVariables</key>\n    <dict>\n${Object.entries(options.environment)
        .map(
          ([key, value]) =>
            `      <key>${escape(key)}</key>\n      <string>${escape(value)}</string>`,
        )
        .join("\n")}\n    </dict>`
    : "";
  const processType = options.processType ? `\n${item("ProcessType", options.processType)}` : "";
  const calendar = options.calendar
    ? `
    <key>StartCalendarInterval</key>
    <array>${options.calendar
      .map(
        ({ hour, minute }) => `
      <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`,
      )
      .join("")}
    </array>
    <key>LowPriorityIO</key><true/>
    <key>Nice</key><integer>10</integer>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
${item("Label", options.label)}
${item("UserName", options.user)}
${item("GroupName", options.group)}
${item("WorkingDirectory", options.workingDirectory)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <${options.keepAlive === false ? "false" : "true"}/>
    <key>SessionCreate</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>Umask</key>
    <integer>63</integer>
${item("StandardOutPath", options.stdout)}
${item("StandardErrorPath", options.stderr)}
    <key>ProgramArguments</key>
    <array>
${args}
    </array>${processType}${environment}${calendar}
  </dict>
</plist>
`;
}
