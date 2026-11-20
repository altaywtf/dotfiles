import { DateTime, Effect, Option, Predicate, Schema, SchemaTransformation } from "effect";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CommandRunner, RawCommandResult } from "../command.ts";
export type { CommandRunner, RawCommandResult } from "../command.ts";

export type HttpResult = {
  status: number;
  body: string;
  error?: Error;
};

export type MacOSUpdateIO = {
  fetch: (
    url: string,
    userAgent: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<HttpResult>;
  readCache: (path: string, signal?: AbortSignal) => Promise<string | undefined>;
  writeCache: (path: string, contents: string, signal?: AbortSignal) => Promise<void>;
};

type FailureKind =
  | "auth"
  | "conflict"
  | "internal"
  | "rate_limit"
  | "transient"
  | "unknown"
  | "validation";
type SourceStatus = "incompatible" | "malformed" | "ok" | "stale" | "unavailable";

export type ReleaseBaseline = {
  version: string;
  build?: string;
  source: "apple_gdmf" | "sofa_macos" | "sofa_safari";
  device_match: string;
};

type UpstreamResult = {
  status: SourceStatus;
  source: ReleaseBaseline["source"];
  freshness: "daily_cache" | "live" | "stale_cache" | "unavailable";
  checked_at: string;
  age_seconds?: number;
  baseline?: ReleaseBaseline;
  error?: string;
  failure_kind?: FailureKind;
  cache_error?: string;
};

type InstalledValue = {
  status: "ok" | "unavailable";
  source: string;
  freshness: "installed";
  version?: string;
  build?: string;
  error?: string;
};

type DeviceValue = {
  status: "ok" | "unavailable";
  source: "ioreg";
  freshness: "installed";
  software_update_id?: string;
  model_identifier?: string;
  board_identifier?: string;
  error?: string;
};

export type SoftwareUpdateResult = {
  available: boolean;
  restart_required: boolean;
  items: string[];
};

type ApplicabilityResult = {
  status: "current" | "failed" | "not_run" | "updates_available";
  source: "softwareupdate --list" | "softwareupdate --list --no-scan";
  freshness: "cached_previous_scan" | "live" | "not_run";
  available?: boolean;
  restart_required?: boolean;
  items: string[];
  error?: string;
  failure_kind?: FailureKind;
  cache_error?: string;
};

export type MacOSUpdateInventory = {
  duration_ms: number;
  installed: {
    os: InstalledValue;
    safari: InstalledValue;
    device: DeviceValue;
  };
  upstream: {
    apple_gdmf: UpstreamResult;
    sofa_macos: UpstreamResult;
    sofa_safari: UpstreamResult;
    selected_os?: ReleaseBaseline;
    selected_safari?: ReleaseBaseline;
  };
  cached_applicability: ApplicabilityResult;
  live_scan: ApplicabilityResult & {
    reasons: string[];
    last_success_at?: string;
    last_success_age_seconds?: number;
  };
  applicability: {
    status: "current" | "unknown" | "updates_available";
    basis: "cached_and_upstream" | "live" | "unknown";
  };
};

export type MacOSUpdateOptions = {
  applicabilityCachePath?: string;
  cachePath?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  fresh: boolean;
  home: string;
  now?: string;
};

const Version = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d+(?:\.\d+){0,3}$/)));
const Build = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d+[A-Za-z]+\d+[A-Za-z0-9]*$/)));
const IsoInstant = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)),
);
const GdmfAsset = Schema.Struct({
  ProductVersion: Version,
  Build,
  SupportedDevices: Schema.Array(Schema.NonEmptyString),
});
const GdmfFeed = Schema.Struct({
  PublicAssetSets: Schema.Struct({ macOS: Schema.Array(GdmfAsset) }),
});
const SofaMacOSFeed = Schema.Struct({
  Version: Schema.NonEmptyString,
  OSVersions: Schema.Array(
    Schema.Struct({
      Latest: Schema.Struct({ ProductVersion: Version, Build }),
      SupportedModels: Schema.Array(
        Schema.Struct({
          Identifiers: Schema.Union([
            Schema.Array(Schema.NonEmptyString),
            Schema.Record(Schema.String, Schema.String).pipe(
              Schema.decodeTo(
                Schema.Array(Schema.String),
                SchemaTransformation.transform<
                  ReadonlyArray<string>,
                  { readonly [x: string]: string }
                >({
                  decode: (identifiers) => Object.keys(identifiers),
                  encode: (identifiers) =>
                    Object.fromEntries(identifiers.map((identifier) => [identifier, identifier])),
                }),
              ),
            ),
          ]),
        }),
      ),
    }),
  ),
});
const SofaSafariFeed = Schema.Struct({
  Version: Schema.NonEmptyString,
  AppVersions: Schema.Array(
    Schema.Struct({
      AppVersion: Schema.NonEmptyString,
      Latest: Schema.Struct({ ProductVersion: Version }),
    }),
  ),
});
const CacheRecord = Schema.Struct({
  schema_version: Schema.Literal(1),
  checked_at: IsoInstant,
  fetched_at: Schema.optional(IsoInstant),
  payload: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  failure_kind: Schema.optional(
    Schema.Literals([
      "auth",
      "conflict",
      "internal",
      "rate_limit",
      "transient",
      "unknown",
      "validation",
    ]),
  ),
});
const LiveScanRecord = Schema.Struct({
  schema_version: Schema.Literal(1),
  completed_at: IsoInstant,
});

type CacheRecord = typeof CacheRecord.Type;
type LiveScanRecord = typeof LiveScanRecord.Type;

const appleUrl = "https://gdmf.apple.com/v2/pmv";
const sofaMacOSUrl = "https://sofafeed.macadmins.io/v2/macos_data_feed.json";
const sofaSafariUrl = "https://sofafeed.macadmins.io/v2/safari_data_feed.json";
const userAgent = "dotfiles-maintenance/1";
const dayMs = 24 * 60 * 60 * 1000;
const commandTimeoutMs = 5000;
const feedTimeoutMs = 1500;
const safariMajorByMacOSMajor = new Map([
  [12, "17"],
  [13, "18"],
  [14, "26"],
  [15, "26"],
]);

function errorMessage(result: RawCommandResult): string {
  if (result.timedOut) return "command timed out";
  return (
    (result.stderr || result.error?.message || result.stdout || `exit ${result.status}`)
      .trim()
      .split(/\r?\n/)[0] ?? `exit ${result.status}`
  );
}

function classifyHttp(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "transient";
  return status >= 400 ? "validation" : "unknown";
}

const JsonPayload = Schema.fromJsonString(Schema.Unknown);

function parseDateTime(value: string): DateTime.Utc | undefined {
  const parsed = Option.getOrUndefined(DateTime.make(value));
  return parsed && DateTime.formatIso(parsed) === value ? parsed : undefined;
}

function ageSeconds(nowMs: number, value: string): number | undefined {
  const parsed = parseDateTime(value);
  if (!parsed) return undefined;
  const ageMs = nowMs - DateTime.toEpochMillis(parsed);
  if (ageMs < 0) return undefined;
  return Math.floor(ageMs / 1000);
}

function commandInstalled(
  result: RawCommandResult,
  source: string,
  fields: { version?: string; build?: string },
): InstalledValue {
  if (result.status !== 0 || result.error || result.timedOut) {
    return { status: "unavailable", source, freshness: "installed", error: errorMessage(result) };
  }
  return { status: "ok", source, freshness: "installed", ...fields };
}

export function parseSoftwareUpdate(result: RawCommandResult): SoftwareUpdateResult {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (/No new software available\.?/i.test(output)) {
    return { available: false, restart_required: false, items: [] };
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items = lines.filter((line) => /^\* Label:|^Label:|^Title:/i.test(line));
  if (items.length === 0) throw new Error("softwareupdate returned an unsupported listing");
  return {
    available: true,
    restart_required: lines.some((line) => /restart/i.test(line)),
    items,
  };
}

function parseApplicability(result: RawCommandResult, live: boolean): ApplicabilityResult {
  const source = live ? "softwareupdate --list" : "softwareupdate --list --no-scan";
  const freshness = live ? "live" : "cached_previous_scan";
  if (result.status !== 0 || result.error || result.timedOut) {
    return {
      status: "failed",
      source,
      freshness,
      items: [],
      error: errorMessage(result),
      failure_kind: result.timedOut ? "transient" : "unknown",
    };
  }
  try {
    const parsed = parseSoftwareUpdate(result);
    return {
      status: parsed.available ? "updates_available" : "current",
      source,
      freshness,
      ...parsed,
    };
  } catch (error) {
    return {
      status: "failed",
      source,
      freshness,
      items: [],
      error: error instanceof Error ? error.message : String(error),
      failure_kind: "validation",
    };
  }
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const parse = (value: string) => {
  const match = /^(\d+)([A-Za-z]+)(\d+)([A-Za-z0-9]*)$/.exec(value);
  if (!match) throw new Error(`invalid Apple build ${value}`);
  return {
    train: Number(match[1]),
    branch: match[2].toUpperCase(),
    revision: Number(match[3]),
    suffix: match[4].toUpperCase(),
  };
};

export function compareBuilds(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  if (a.train !== b.train) return Math.sign(a.train - b.train);
  const branch = a.branch.localeCompare(b.branch);
  if (branch !== 0) return Math.sign(branch);
  if (a.revision !== b.revision) return Math.sign(a.revision - b.revision);
  if (a.suffix === "" && b.suffix !== "") return 1;
  if (a.suffix !== "" && b.suffix === "") return -1;
  return Math.sign(a.suffix.localeCompare(b.suffix));
}

function compareBaselines(left: ReleaseBaseline, right: ReleaseBaseline): number {
  const version = compareVersions(left.version, right.version);
  if (version !== 0 || !left.build || !right.build) return version;
  return compareBuilds(left.build, right.build);
}

function newest(values: readonly ReleaseBaseline[]): ReleaseBaseline | undefined {
  return values.reduce<ReleaseBaseline | undefined>(
    (selected, value) => (!selected || compareBaselines(value, selected) > 0 ? value : selected),
    undefined,
  );
}

export function selectGdmfBaseline(
  payload: unknown,
  deviceIdentifiers: readonly string[],
): ReleaseBaseline {
  const feed = Schema.decodeUnknownSync(GdmfFeed)(payload);
  const identifiers = new Set(deviceIdentifiers.filter(Boolean));
  const candidates = feed.PublicAssetSets.macOS.flatMap((asset) => {
    const device = asset.SupportedDevices.find((identifier) => identifiers.has(identifier));
    return device === undefined
      ? []
      : [
          {
            version: asset.ProductVersion,
            build: asset.Build,
            source: "apple_gdmf" as const,
            device_match: device,
          },
        ];
  });
  const selected = newest(candidates);
  if (!selected)
    throw new Error("Apple GDMF is incompatible with this software-update device identifier");
  return selected;
}

export function selectSofaMacOSBaseline(
  payload: unknown,
  modelIdentifier: string,
): ReleaseBaseline {
  const feed = Schema.decodeUnknownSync(SofaMacOSFeed)(payload);
  const candidates = feed.OSVersions.filter((release) =>
    release.SupportedModels.some((group) => group.Identifiers.includes(modelIdentifier)),
  ).map((release) => ({
    version: release.Latest.ProductVersion,
    build: release.Latest.Build,
    source: "sofa_macos" as const,
    device_match: modelIdentifier,
  }));
  const selected = newest(candidates);
  if (!selected) throw new Error("SOFA macOS is incompatible with this model identifier");
  return selected;
}

function compatibleSafariMajor(
  installedSafariVersion: string,
  installedMacOSVersion: string,
): string {
  const safariMajor = installedSafariVersion.split(".")[0] ?? "";
  const macOSMajor = Number(installedMacOSVersion.split(".")[0]);
  if (macOSMajor >= 26) return String(macOSMajor);
  return safariMajorByMacOSMajor.get(macOSMajor) ?? safariMajor;
}

export function selectSofaSafariBaseline(
  payload: unknown,
  installedVersion: string,
  installedMacOSVersion: string,
): ReleaseBaseline {
  const feed = Schema.decodeUnknownSync(SofaSafariFeed)(payload);
  const major = compatibleSafariMajor(installedVersion, installedMacOSVersion);
  const candidates = feed.AppVersions.filter(
    (release) => release.AppVersion.match(/\d+/)?.[0] === major,
  ).map((release) => ({
    version: release.Latest.ProductVersion,
    source: "sofa_safari" as const,
    device_match: `Safari ${major}`,
  }));
  const selected = newest(candidates);
  if (!selected) throw new Error(`SOFA Safari is incompatible with Safari ${major}`);
  return selected;
}

function sourceFailure(
  source: UpstreamResult["source"],
  checkedAt: string,
  status: Exclude<SourceStatus, "ok">,
  freshness: UpstreamResult["freshness"],
  error: string,
  failureKind: FailureKind,
  age?: number,
): UpstreamResult {
  return {
    status,
    source,
    freshness,
    checked_at: checkedAt,
    error,
    failure_kind: failureKind,
    ...(age === undefined ? {} : { age_seconds: age }),
  };
}

function selectPayload(
  source: UpstreamResult["source"],
  payload: unknown,
  checkedAt: string,
  freshness: UpstreamResult["freshness"],
  select: (value: unknown) => ReleaseBaseline,
  age?: number,
): UpstreamResult {
  try {
    return {
      status: freshness === "stale_cache" ? "stale" : "ok",
      source,
      freshness,
      checked_at: checkedAt,
      baseline: select(payload),
      ...(age === undefined ? {} : { age_seconds: age }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const incompatible = /incompatible/i.test(message);
    return sourceFailure(
      source,
      checkedAt,
      incompatible ? "incompatible" : "malformed",
      freshness,
      message,
      "validation",
      age,
    );
  }
}

function parseCache(contents: string | undefined): { record?: CacheRecord; error?: string } {
  if (contents === undefined) return {};
  try {
    return { record: Schema.decodeUnknownSync(Schema.fromJsonString(CacheRecord))(contents) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function parseLiveScanRecord(contents: string | undefined): {
  record?: LiveScanRecord;
  error?: string;
} {
  if (contents === undefined) return {};
  try {
    return { record: Schema.decodeUnknownSync(Schema.fromJsonString(LiveScanRecord))(contents) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function readCacheResult(
  io: MacOSUpdateIO,
  path: string,
): Promise<{ contents?: string; error?: string }> {
  try {
    return { contents: await io.readCache(path) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function appleSource(
  io: MacOSUpdateIO,
  cachePath: string,
  nowIso: string,
  nowMs: number,
  identifiers: readonly string[],
): Promise<UpstreamResult> {
  const cached = parseCache(await io.readCache(cachePath).catch(() => undefined));
  const checkedAge = cached.record ? ageSeconds(nowMs, cached.record.checked_at) : undefined;
  const fetchedAge = cached.record?.fetched_at
    ? ageSeconds(nowMs, cached.record.fetched_at)
    : undefined;
  const fetchedAgeUnknown = cached.record?.fetched_at !== undefined && fetchedAge === undefined;
  const reusableCache =
    cached.record && checkedAge !== undefined && !fetchedAgeUnknown ? cached.record : undefined;
  if (reusableCache && checkedAge !== undefined && checkedAge < dayMs / 1000) {
    if (reusableCache.payload !== undefined) {
      const result = selectPayload(
        "apple_gdmf",
        reusableCache.payload,
        reusableCache.checked_at,
        fetchedAge !== undefined && fetchedAge >= dayMs / 1000 ? "stale_cache" : "daily_cache",
        (payload) => selectGdmfBaseline(payload, identifiers),
        fetchedAge,
      );
      return result.freshness === "stale_cache" && reusableCache.error
        ? {
            ...result,
            error: reusableCache.error,
            failure_kind: reusableCache.failure_kind ?? "unknown",
          }
        : result;
    }
    return sourceFailure(
      "apple_gdmf",
      reusableCache.checked_at,
      "unavailable",
      "unavailable",
      reusableCache.error ?? "Apple GDMF is unavailable",
      reusableCache.failure_kind ?? "unknown",
    );
  }

  const response = await io.fetch(appleUrl, userAgent, feedTimeoutMs);
  let payload: unknown;
  let failure: { error: string; kind: FailureKind } | undefined;
  if (response.error) {
    failure = { error: response.error.message, kind: "transient" };
  } else if (response.status < 200 || response.status >= 300) {
    failure = {
      error: `Apple GDMF returned HTTP ${response.status}`,
      kind: classifyHttp(response.status),
    };
  } else {
    try {
      payload = Schema.decodeUnknownSync(JsonPayload)(response.body);
    } catch (error) {
      failure = {
        error: error instanceof Error ? error.message : String(error),
        kind: "validation",
      };
    }
  }

  const record: CacheRecord = {
    schema_version: 1,
    checked_at: nowIso,
    ...(failure
      ? {
          ...(reusableCache?.payload === undefined ? {} : { payload: reusableCache.payload }),
          ...(reusableCache?.fetched_at === undefined
            ? {}
            : { fetched_at: reusableCache.fetched_at }),
          error: failure.error,
          failure_kind: failure.kind,
        }
      : { fetched_at: nowIso, payload }),
  };
  let cacheError: string | undefined;
  try {
    await io.writeCache(cachePath, JSON.stringify(record));
  } catch (error) {
    cacheError = error instanceof Error ? error.message : String(error);
  }

  if (failure) {
    if (record.payload !== undefined && record.fetched_at) {
      const result = selectPayload(
        "apple_gdmf",
        record.payload,
        nowIso,
        "stale_cache",
        (value) => selectGdmfBaseline(value, identifiers),
        ageSeconds(nowMs, record.fetched_at),
      );
      return {
        ...result,
        error: failure.error,
        failure_kind: failure.kind,
        ...(cacheError ? { cache_error: cacheError } : {}),
      };
    }
    return {
      ...sourceFailure(
        "apple_gdmf",
        nowIso,
        "unavailable",
        "unavailable",
        failure.error,
        failure.kind,
      ),
      ...(cacheError ? { cache_error: cacheError } : {}),
    };
  }
  const result = selectPayload(
    "apple_gdmf",
    payload,
    nowIso,
    "live",
    (value) => selectGdmfBaseline(value, identifiers),
    0,
  );
  return { ...result, ...(cacheError ? { cache_error: cacheError } : {}) };
}

async function sofaSource(
  io: MacOSUpdateIO,
  source: "sofa_macos" | "sofa_safari",
  url: string,
  nowIso: string,
  select: (payload: unknown) => ReleaseBaseline,
): Promise<UpstreamResult> {
  const response = await io.fetch(url, userAgent, feedTimeoutMs);
  if (response.error)
    return sourceFailure(
      source,
      nowIso,
      "unavailable",
      "unavailable",
      response.error.message,
      "transient",
    );
  if (response.status < 200 || response.status >= 300) {
    return sourceFailure(
      source,
      nowIso,
      "unavailable",
      "unavailable",
      `${source} returned HTTP ${response.status}`,
      classifyHttp(response.status),
    );
  }
  try {
    return selectPayload(
      source,
      Schema.decodeUnknownSync(JsonPayload)(response.body),
      nowIso,
      "live",
      select,
      0,
    );
  } catch (error) {
    return sourceFailure(
      source,
      nowIso,
      "malformed",
      "live",
      error instanceof Error ? error.message : String(error),
      "validation",
      0,
    );
  }
}

function parseDevice(result: RawCommandResult): DeviceValue {
  if (result.status !== 0 || result.error || result.timedOut) {
    return {
      status: "unavailable",
      source: "ioreg",
      freshness: "installed",
      error: errorMessage(result),
    };
  }
  const softwareUpdateId = /^\+-o\s+(\S+)/m.exec(result.stdout)?.[1];
  const modelIdentifier = /"model"\s*=\s*<"([^"]+)">/.exec(result.stdout)?.[1];
  const boardIdentifier = /"board-id"\s*=\s*<"([^"]+)">/.exec(result.stdout)?.[1];
  if (!softwareUpdateId && !modelIdentifier && !boardIdentifier) {
    return {
      status: "unavailable",
      source: "ioreg",
      freshness: "installed",
      error: "ioreg did not return a supported device identifier",
    };
  }
  return {
    status: "ok",
    source: "ioreg",
    freshness: "installed",
    ...(softwareUpdateId ? { software_update_id: softwareUpdateId } : {}),
    ...(modelIdentifier ? { model_identifier: modelIdentifier } : {}),
    ...(boardIdentifier ? { board_identifier: boardIdentifier } : {}),
  };
}

function runCommand(
  runner: CommandRunner,
  options: MacOSUpdateOptions,
  command: string,
  args: readonly string[],
  timeoutMs: number | null,
) {
  return Effect.tryPromise({
    try: () => runner(command, args, { cwd: options.cwd, env: options.env, timeoutMs }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        status: 1,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    ),
  );
}

const collectMacOSUpdateInventoryEffect = Effect.fn("collectMacOSUpdateInventory")(function* (
  options: MacOSUpdateOptions,
  runner: CommandRunner,
  io: MacOSUpdateIO,
) {
  const started = performance.now();
  const now = options.now ? parseDateTime(options.now) : yield* DateTime.now;
  if (!now) return yield* Effect.die(new Error(`invalid inventory time ${options.now}`));
  const nowIso = DateTime.formatIso(now);
  const nowMs = DateTime.toEpochMillis(now);

  const applicabilityCachePath =
    options.applicabilityCachePath ??
    join(options.home, ".cache/dotfiles/macos-updates/softwareupdate-live.json");
  const [
    osVersionResult,
    osBuildResult,
    safariResult,
    deviceResult,
    cachedResult,
    liveScanCacheResult,
  ] = yield* Effect.all(
    [
      runCommand(runner, options, "sw_vers", ["-productVersion"], commandTimeoutMs),
      runCommand(runner, options, "sw_vers", ["-buildVersion"], commandTimeoutMs),
      runCommand(
        runner,
        options,
        "defaults",
        ["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"],
        commandTimeoutMs,
      ),
      runCommand(
        runner,
        options,
        "ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        commandTimeoutMs,
      ),
      runCommand(runner, options, "softwareupdate", ["-l", "--no-scan"], commandTimeoutMs),
      Effect.promise(() => readCacheResult(io, applicabilityCachePath)),
    ],
    { concurrency: "unbounded" },
  );

  const osVersion = osVersionResult.stdout.trim();
  const osBuild = osBuildResult.stdout.trim();
  const safariVersion = safariResult.stdout.trim();
  const version = commandInstalled(
    osVersionResult,
    "sw_vers",
    Schema.is(Version)(osVersion) ? { version: osVersion } : {},
  );
  const build = commandInstalled(
    osBuildResult,
    "sw_vers",
    Schema.is(Build)(osBuild) ? { build: osBuild } : {},
  );
  const installedOs: InstalledValue =
    version.status === "ok" && build.status === "ok" && version.version && build.build
      ? {
          status: "ok",
          source: "sw_vers",
          freshness: "installed",
          version: version.version,
          build: build.build,
        }
      : {
          status: "unavailable",
          source: "sw_vers",
          freshness: "installed",
          error: version.error ?? build.error ?? "sw_vers returned an invalid version or build",
        };
  const safari = commandInstalled(
    safariResult,
    "Safari Info.plist",
    Schema.is(Version)(safariVersion) ? { version: safariVersion } : {},
  );
  const installedSafari =
    safari.status === "unavailable" || safari.version
      ? safari
      : {
          status: "unavailable" as const,
          source: "Safari Info.plist",
          freshness: "installed" as const,
          error: "Safari returned an invalid version",
        };
  const device = parseDevice(deviceResult);
  const cachedApplicability = parseApplicability(cachedResult, false);
  const liveScanCache = liveScanCacheResult.error
    ? { error: liveScanCacheResult.error }
    : parseLiveScanRecord(liveScanCacheResult.contents);
  const lastLiveScanAge = liveScanCache.record
    ? ageSeconds(nowMs, liveScanCache.record.completed_at)
    : undefined;
  const liveScanCacheError =
    liveScanCache.error ??
    (liveScanCache.record && lastLiveScanAge === undefined
      ? "cached live-scan timestamp is invalid"
      : undefined);
  const identifiers =
    device.status === "ok"
      ? [device.software_update_id, device.board_identifier, device.model_identifier].filter(
          Predicate.isNotUndefined,
        )
      : [];
  const cachePath =
    options.cachePath ?? join(options.home, ".cache/dotfiles/macos-updates/apple-gdmf.json");

  const [apple, sofaMacOS, sofaSafari] = yield* Effect.all(
    [
      Effect.promise(() => appleSource(io, cachePath, nowIso, nowMs, identifiers)),
      Effect.promise(() =>
        sofaSource(io, "sofa_macos", sofaMacOSUrl, nowIso, (payload) =>
          selectSofaMacOSBaseline(payload, device.model_identifier ?? ""),
        ),
      ),
      Effect.promise(() =>
        sofaSource(io, "sofa_safari", sofaSafariUrl, nowIso, (payload) =>
          selectSofaSafariBaseline(
            payload,
            installedSafari.version ?? "",
            installedOs.version ?? "",
          ),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const selectedOs = newest(
    [apple, sofaMacOS].flatMap((source) =>
      source.status === "ok" && source.baseline ? [source.baseline] : [],
    ),
  );
  const selectedSafari = sofaSafari.status === "ok" ? sofaSafari.baseline : undefined;
  const reasons: string[] = [];
  if (options.fresh) reasons.push("explicit_fresh");
  if (liveScanCacheError || lastLiveScanAge === undefined) reasons.push("live_scan_age_unknown");
  else if (lastLiveScanAge >= dayMs / 1000) reasons.push("live_scan_stale");
  if (cachedApplicability.status === "failed") reasons.push("cached_applicability_invalid");
  else if (cachedApplicability.available) reasons.push("cached_backlog_nonempty");
  if (
    installedOs.status !== "ok" ||
    !installedOs.version ||
    !installedOs.build ||
    device.status !== "ok"
  )
    reasons.push("installed_state_invalid");
  if (!selectedOs) reasons.push("upstream_os_unavailable");
  if (installedSafari.status !== "ok" || !installedSafari.version || !selectedSafari)
    reasons.push("upstream_safari_unavailable");
  if (selectedOs && installedOs.version && installedOs.build) {
    const version = compareVersions(selectedOs.version, installedOs.version);
    if (
      version > 0 ||
      (version === 0 && selectedOs.build && compareBuilds(selectedOs.build, installedOs.build) > 0)
    )
      reasons.push("upstream_os_newer");
  }
  if (
    selectedSafari &&
    installedSafari.version &&
    compareVersions(selectedSafari.version, installedSafari.version) > 0
  )
    reasons.push("upstream_safari_newer");

  let liveScan: MacOSUpdateInventory["live_scan"] = {
    status: "not_run",
    source: "softwareupdate --list",
    freshness: "not_run",
    items: [],
    reasons: [...new Set(reasons)],
    ...(lastLiveScanAge === undefined || !liveScanCache.record
      ? {}
      : {
          last_success_at: liveScanCache.record.completed_at,
          last_success_age_seconds: lastLiveScanAge,
        }),
    ...(liveScanCacheError ? { cache_error: liveScanCacheError } : {}),
  };
  if (reasons.length > 0) {
    const live = parseApplicability(
      yield* runCommand(runner, options, "softwareupdate", ["-l"], null),
      true,
    );
    const uniqueReasons = [...new Set(reasons)];
    liveScan = { ...liveScan, ...live, reasons: uniqueReasons };
    if (live.status === "current" || live.status === "updates_available") {
      const cacheWriteError = yield* Effect.promise(async () => {
        try {
          await io.writeCache(
            applicabilityCachePath,
            JSON.stringify({ schema_version: 1, completed_at: nowIso } satisfies LiveScanRecord),
          );
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
      if (cacheWriteError) {
        liveScan = { ...liveScan, cache_error: cacheWriteError };
      } else {
        liveScan = {
          ...live,
          reasons: uniqueReasons,
          last_success_at: nowIso,
          last_success_age_seconds: 0,
        };
      }
    }
  }

  const applicability =
    liveScan.status === "current"
      ? { status: "current" as const, basis: "live" as const }
      : liveScan.status === "updates_available"
        ? { status: "updates_available" as const, basis: "live" as const }
        : liveScan.status === "failed"
          ? { status: "unknown" as const, basis: "unknown" as const }
          : cachedApplicability.status === "current" && selectedOs && selectedSafari
            ? { status: "current" as const, basis: "cached_and_upstream" as const }
            : { status: "unknown" as const, basis: "unknown" as const };

  return {
    duration_ms: Math.round(performance.now() - started),
    installed: { os: installedOs, safari: installedSafari, device },
    upstream: {
      apple_gdmf: apple,
      sofa_macos: sofaMacOS,
      sofa_safari: sofaSafari,
      ...(selectedOs ? { selected_os: selectedOs } : {}),
      ...(selectedSafari ? { selected_safari: selectedSafari } : {}),
    },
    cached_applicability: cachedApplicability,
    live_scan: liveScan,
    applicability,
  } satisfies MacOSUpdateInventory;
});

export async function collectMacOSUpdateInventory(
  options: MacOSUpdateOptions,
  runner: CommandRunner,
  io: MacOSUpdateIO = defaultMacOSUpdateIO,
  signal?: AbortSignal,
): Promise<MacOSUpdateInventory> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const active = new Set<Promise<unknown>>();
  const runIO = async <A>(operation: () => Promise<A>): Promise<A> => {
    controller.signal.throwIfAborted();
    const pending = operation();
    active.add(pending);
    try {
      const result = await pending;
      controller.signal.throwIfAborted();
      return result;
    } finally {
      active.delete(pending);
    }
  };
  const boundedIO: MacOSUpdateIO = {
    fetch: (url, agent, timeoutMs) =>
      runIO(() => io.fetch(url, agent, timeoutMs, controller.signal)),
    readCache: (path) => runIO(() => io.readCache(path, controller.signal)),
    writeCache: (path, contents) => runIO(() => io.writeCache(path, contents, controller.signal)),
  };
  try {
    return await Effect.runPromise(
      collectMacOSUpdateInventoryEffect(
        options,
        (command, args, commandOptions) => runIO(() => runner(command, args, commandOptions)),
        boundedIO,
      ),
      { signal: controller.signal },
    );
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", abort);
    await Promise.allSettled(active);
  }
}

export const defaultMacOSUpdateIO: MacOSUpdateIO = {
  async fetch(url, agent, timeoutMs, signal) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": agent },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return {
        status: 0,
        body: "",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
  async readCache(path, signal) {
    try {
      return await readFile(path, { encoding: "utf8", signal });
    } catch (error) {
      if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") return undefined;
      throw error;
    }
  },
  async writeCache(path, contents, signal) {
    signal?.throwIfAborted();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, signal });
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  },
};
