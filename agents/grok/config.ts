import { Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join } from "node:path";
import { CommandRunner } from "../../lib/command.ts";
import { fail } from "../../lib/program.ts";

type Setting = { table: string; key: string; value: boolean | string };

// mise pins own the Grok version, so its npm self-updater stays off. The
// harness keys stop per-turn workspace and codebase uploads to xAI.
const MANAGED_SETTINGS: readonly Setting[] = [
  { table: "ui", key: "permission_mode", value: "auto" },
  { table: "cli", key: "auto_update", value: false },
  { table: "features", key: "telemetry", value: false },
  { table: "features", key: "feedback", value: false },
  { table: "telemetry", key: "trace_upload", value: false },
  { table: "harness", key: "disable_workspace_teleport", value: true },
  { table: "harness", key: "disable_codebase_upload", value: true },
];

type Line = { text: string; open: boolean; code: string };

// Marks lines that start inside a multi-line array, inline table, or string
// and strips comments, so value text is never read as a header or key.
function scan(contents: string): Line[] {
  let depth = 0;
  let multiline: string | undefined;
  return contents.split("\n").map((text) => {
    const open = depth > 0 || multiline !== undefined;
    const header = !open && /^\s*\[/.test(text);
    let code = "";
    let quote: string | undefined;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (multiline !== undefined) {
        if (multiline === '"""' && char === "\\") {
          code += text.slice(index, index + 2);
          index += 1;
        } else if (text.startsWith(multiline, index)) {
          code += multiline;
          index += 2;
          multiline = undefined;
        } else code += char;
        continue;
      }
      if (quote !== undefined) {
        code += char;
        if (char === "\\" && quote === '"') {
          code += text[index + 1] ?? "";
          index += 1;
        } else if (char === quote) quote = undefined;
        continue;
      }
      if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
        multiline = text.slice(index, index + 3);
        code += multiline;
        index += 2;
        continue;
      }
      if (char === "#") break;
      code += char;
      if (char === '"' || char === "'") quote = char;
      else if (!header && (char === "[" || char === "{")) depth += 1;
      else if (!header && (char === "]" || char === "}") && depth > 0) depth -= 1;
    }
    return { text, open, code };
  });
}

const isHeader = (line: Line) => !line.open && /^\s*\[/.test(line.code);

function headerName(line: Line): string | undefined {
  const match = /^\s*\[([^[\]]+)\]\s*$/.exec(line.code);
  if (line.open || !match) return undefined;
  return match[1]
    .split(".")
    .map((part) => part.trim().replace(/^"([^"\\]*)"$|^'([^']*)'$/, "$1$2"))
    .join(".");
}

function sectionOf(lines: readonly Line[], table: string): [number, number] | undefined {
  const start = lines.findIndex((line) => headerName(line) === table);
  if (start === -1) return undefined;
  const next = lines.findIndex((line, index) => index > start && isHeader(line));
  return [start, next === -1 ? lines.length : next];
}

// The root section spans from before the first line to the first header.
function rootSection(lines: readonly Line[]): [number, number] {
  const first = lines.findIndex(isHeader);
  return [-1, first === -1 ? lines.length : first];
}

const keyPattern = (key: string, suffix: string) =>
  new RegExp(
    `^\\s*${key
      .split(".")
      .map((part) => {
        const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return `(?:${escaped}|"${escaped}"|'${escaped}')`;
      })
      .join("\\s*\\.\\s*")}\\s*${suffix}`,
  );

// Returns the [first, last] line indexes of a key's assignment in a section.
function keySpan(
  lines: readonly Line[],
  [start, end]: [number, number],
  key: string,
): [number, number] | undefined {
  const pattern = keyPattern(key, "=");
  for (let index = start + 1; index < end; index += 1) {
    if (lines[index].open || !pattern.test(lines[index].code)) continue;
    let last = index;
    while (last + 1 < end && lines[last + 1].open) last += 1;
    return [index, last];
  }
  return undefined;
}

function upsert(
  lines: readonly Line[],
  section: [number, number],
  key: string,
  value: string,
): Line[] {
  const assignment = `${key} = ${value}`;
  const span = keySpan(lines, section, key);
  if (span && span[0] === span[1]) {
    const current = lines[span[0]].code;
    if (current.slice(current.indexOf("=") + 1).trim() === value) return [...lines];
  }
  const texts = lines.map((line) => line.text);
  if (span) texts.splice(span[0], span[1] - span[0] + 1, assignment);
  else {
    let insertAt = section[1];
    while (insertAt - 1 > section[0] && texts[insertAt - 1].trim() === "") insertAt -= 1;
    texts.splice(insertAt, 0, assignment);
  }
  return scan(texts.join("\n"));
}

const render = (value: boolean | string) =>
  typeof value === "boolean" ? String(value) : JSON.stringify(value);

export function applyManagedSettings(contents: string): string {
  let lines = scan(contents.replace(/\n*$/, ""));
  const appended = new Map<string, string[]>();
  for (const { table, key, value } of MANAGED_SETTINGS) {
    const section = sectionOf(lines, table);
    if (section) {
      lines = upsert(lines, section, key, render(value));
      continue;
    }
    const root = rootSection(lines);
    if (keySpan(lines, root, table))
      throw new Error(`Grok config defines ${table} as an inline table`);
    const dotted = keyPattern(table, "\\.");
    if (lines.slice(0, root[1]).some((line) => !line.open && dotted.test(line.code))) {
      lines = upsert(lines, root, `${table}.${key}`, render(value));
      continue;
    }
    appended.set(table, [...(appended.get(table) ?? []), `${key} = ${render(value)}`]);
  }
  const body = lines.map((line) => line.text).join("\n");
  const tables = [...appended].map(([table, entries]) => [`[${table}]`, ...entries].join("\n"));
  const updated = [body, ...tables].filter((part) => part.trim() !== "").join("\n\n");
  return updated === contents.replace(/\n*$/, "") ? contents : `${updated}\n`;
}

export const configureGrokDefaults = Effect.fn("configureGrokDefaults")(function* (
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(configPath).pipe(Effect.option);
  if (Option.isSome(link)) return yield* fail(`Grok config must be a regular file: ${configPath}`);
  const info = yield* fs.stat(configPath).pipe(Effect.option);
  if (Option.isSome(info) && info.value.type !== "File")
    return yield* fail(`Grok config must be a regular file: ${configPath}`);
  const original = Option.isSome(info) ? yield* fs.readFileString(configPath) : "";
  const updated = yield* Effect.try({
    try: () => applyManagedSettings(original),
    catch: (error) => error,
  });
  if (updated === original && Option.isSome(info) && (info.value.mode & 0o077) === 0) return false;
  yield* fs.makeDirectory(dirname(configPath), { recursive: true, mode: 0o700 });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: dirname(configPath),
        prefix: ".config.toml.",
      });
      const temporary = join(directory, "config.toml");
      yield* fs.writeFileString(temporary, updated, { mode: 0o600 });
      yield* fs.rename(temporary, configPath);
      yield* fs.chmod(configPath, 0o600);
    }),
  );
  return true;
});

const PinnedPackage = Schema.Struct({ version: Schema.String });

// mise's npm backend installs either a local tree or a global prefix.
const PIN_LAYOUTS = [
  { manifest: "node_modules/@xai-official/grok/package.json", launcher: "node_modules/.bin/grok" },
  { manifest: "lib/node_modules/@xai-official/grok/package.json", launcher: "bin/grok" },
] as const;

// Grok's launcher runs ~/.grok/bin/grok whatever version it links to, and
// mise installs without lifecycle scripts, so a pin bump never restages it.
// Moving a stale link aside makes the pinned launcher stage its own version;
// the previous link returns if staging fails.
export const alignPinnedBinary = Effect.fn("alignPinnedBinary")(function* (grokHome: string) {
  const runner = yield* CommandRunner;
  const fs = yield* FileSystem.FileSystem;
  const where = yield* runner.run("mise", ["where", "npm:@xai-official/grok"]);
  if (where.status !== 0) {
    if (/ not installed$/m.test(where.stderr)) return Option.none<string>();
    return yield* fail(`mise could not resolve the Grok pin: ${where.stderr.trim()}`);
  }
  const installDir = where.stdout.trim();
  let layout: (typeof PIN_LAYOUTS)[number] | undefined;
  for (const candidate of PIN_LAYOUTS)
    if (yield* fs.exists(join(installDir, candidate.manifest))) {
      layout = candidate;
      break;
    }
  if (layout === undefined) return yield* fail(`no Grok package under the pin at ${installDir}`);
  const { version } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PinnedPackage))(
    yield* fs.readFileString(join(installDir, layout.manifest)),
  );
  const canonical = join(grokHome, "bin", "grok");
  const target = yield* fs.readLink(canonical).pipe(Effect.option);
  if (Option.isSome(target) && target.value === `grok-${version}`) return Option.some(version);
  const previous = `${canonical}.previous`;
  yield* fs.remove(previous, { force: true });
  const movedAside = Option.isSome(yield* fs.rename(canonical, previous).pipe(Effect.option));
  const launched = yield* runner
    .run(join(installDir, layout.launcher), ["--version"], { env: { GROK_HOME: grokHome } })
    .pipe(
      Effect.catch((error) => Effect.succeed({ status: -1, stdout: "", stderr: error.message })),
    );
  if (
    launched.status === 0 &&
    new RegExp(`^grok ${version.replace(/\./g, "\\.")}(\\s|$)`).test(launched.stdout)
  ) {
    yield* fs.remove(previous, { force: true });
    return Option.some(version);
  }
  if (movedAside) {
    yield* fs.remove(canonical, { force: true });
    yield* fs.rename(previous, canonical);
  }
  return yield* fail(
    `pinned Grok ${version} did not stage (exit ${launched.status}): ${`${launched.stdout}\n${launched.stderr}`.trim()}`,
  );
});
