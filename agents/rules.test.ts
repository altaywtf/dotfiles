import { NodeServices } from "@effect/platform-node";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { Effect, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { CommandRunner } from "../lib/command.ts";
import {
  composeRuleSources,
  parseRuleSourceConfig,
  refreshAgentRules,
  RuleContentFailure,
  RuleRefreshUnavailable,
  liveRuleRuntime,
  type RuleRuntime,
} from "./rules.ts";

const originalRules = "## General guidelines\n\nOriginal rules.\n";

function createFixture(
  sources = ["https://rules.example.test/shared.md"],
  options: { readonly cached?: boolean } = { cached: true },
): { cache: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agent-rules-"));
  const cache = join(root, "state/dotfiles/agent-rules.md");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents/rules.json"), `${JSON.stringify({ version: 1, sources })}\n`);
  if (options.cached !== false) {
    mkdirSync(join(root, "state/dotfiles"), { recursive: true });
    writeFileSync(cache, originalRules);
  }
  return { cache, root };
}

function run<A>(
  effect: Effect.Effect<A, unknown, FileSystem.FileSystem | CommandRunner>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
  );
}

async function captureWarnings<A>(action: (warnings: string[]) => Promise<A>): Promise<A> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map(String).join(" "));
  };
  try {
    return await action(warnings);
  } finally {
    console.warn = originalWarn;
  }
}

test("parses a strict ordered HTTPS source config", async () => {
  const parsed = await Effect.runPromise(
    parseRuleSourceConfig(
      JSON.stringify({
        version: 1,
        sources: ["https://rules.example.test/first.md", "https://rules.example.test/second.md"],
      }),
    ),
  );
  assert.deepEqual(parsed.sources, [
    "https://rules.example.test/first.md",
    "https://rules.example.test/second.md",
  ]);
  await assert.rejects(
    Effect.runPromise(parseRuleSourceConfig('{"version":1,"sources":[],"extra":true}')),
    /sources|extra/,
  );
  await assert.rejects(
    Effect.runPromise(
      parseRuleSourceConfig('{"version":1,"sources":["http://rules.example.test"]}'),
    ),
    /sources/,
  );
});

test("composes normalized source fragments in configured order", async () => {
  const contents = await Effect.runPromise(
    composeRuleSources([
      { source: "first", contents: "\r\n## General guidelines\r\n\r\nFirst.\r\n" },
      { source: "second", contents: "\n### Delivery\n\nSecond.\n\n" },
    ]),
  );
  assert.equal(contents, "## General guidelines\n\nFirst.\n\n### Delivery\n\nSecond.\n");
  await assert.rejects(
    Effect.runPromise(composeRuleSources([{ source: "empty", contents: " \n" }])),
    /source is empty/,
  );
  await assert.rejects(
    Effect.runPromise(
      composeRuleSources([{ source: "frontmatter", contents: "---\ntitle: rules\n---\n" }]),
    ),
    /has frontmatter/,
  );
  await assert.rejects(
    Effect.runPromise(composeRuleSources([{ source: "heading", contents: "# Agent rules\n" }])),
    /must start at ## General guidelines/,
  );
});

test("refreshes the cache only after every source and the secret scan succeed", async () => {
  const sources = ["https://rules.example.test/first.md", "https://rules.example.test/second.md"];
  const { cache, root } = createFixture(sources, { cached: false });
  const fetched = new Map([
    [sources[0], "## General guidelines\n\nFirst.\n"],
    [sources[1], "### Delivery\n\nSecond.\n"],
  ]);
  let scanned = "";
  const runtime: RuleRuntime = {
    fetch: (url) => Effect.succeed(fetched.get(url) ?? ""),
    scan: (contents) =>
      Effect.sync(() => {
        scanned = contents;
      }),
  };
  try {
    assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "updated");
    const expected = "## General guidelines\n\nFirst.\n\n### Delivery\n\nSecond.\n";
    assert.equal(readFileSync(cache, "utf8"), expected);
    assert.equal(statSync(cache).mode & 0o777, 0o600);
    assert.equal(scanned, expected);
    assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "current");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("keeps the cache when refresh or secret validation is unavailable", async () => {
  const runtimes: RuleRuntime[] = [
    {
      fetch: (url) => Effect.fail(new RuleRefreshUnavailable({ message: `offline: ${url}` })),
      scan: () => Effect.succeed(undefined),
    },
    {
      fetch: () => Effect.succeed("## General guidelines\n\nFetched.\n"),
      scan: () => Effect.fail(new RuleRefreshUnavailable({ message: "scanner unavailable" })),
    },
  ];
  for (const runtime of runtimes) {
    const { cache, root } = createFixture();
    try {
      assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "offline");
      assert.equal(readFileSync(cache, "utf8"), originalRules);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("includes HTTP failures in the machine-local cache warning", async () => {
  const { cache, root } = createFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 503 });
  try {
    await captureWarnings(async (warnings) => {
      assert.equal(
        await run(refreshAgentRules(root, cache, { runtime: liveRuleRuntime })),
        "offline",
      );
      assert.deepEqual(warnings, [
        "cannot fetch agent rule source: https://rules.example.test/shared.md: HTTP 503; using the machine-local cache",
      ]);
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { force: true, recursive: true });
  }
});

test("includes timeout failures in the machine-local cache warning", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  let timeoutError: RuleRefreshUnavailable;
  try {
    timeoutError = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          liveRuleRuntime.fetch("https://rules.example.test/shared.md").pipe(Effect.flip),
        );
        yield* TestClock.adjust("10 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { cache, root } = createFixture();
  const runtime: RuleRuntime = {
    fetch: () => Effect.fail(timeoutError),
    scan: () => Effect.succeed(undefined),
  };
  try {
    await captureWarnings(async (warnings) => {
      assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "offline");
      assert.deepEqual(warnings, [
        "cannot fetch agent rule source: https://rules.example.test/shared.md: timed out after 10 seconds; using the machine-local cache",
      ]);
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects invalid or secret-bearing fetched content without replacing the cache", async () => {
  const runtimes: RuleRuntime[] = [
    {
      fetch: () => Effect.succeed("---\ntitle: rules\n---\n"),
      scan: () => Effect.succeed(undefined),
    },
    {
      fetch: () => Effect.succeed("## General guidelines\n\nFetched.\n"),
      scan: () => Effect.fail(new RuleContentFailure({ message: "possible secret" })),
    },
  ];
  for (const runtime of runtimes) {
    const { cache, root } = createFixture();
    try {
      await assert.rejects(
        run(refreshAgentRules(root, cache, { runtime })),
        /frontmatter|possible secret/,
      );
      assert.equal(readFileSync(cache, "utf8"), originalRules);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("requires a machine-local cache when offline or refresh is unavailable", async () => {
  const { cache, root } = createFixture(undefined, { cached: false });
  const runtime: RuleRuntime = {
    fetch: (url) => Effect.fail(new RuleRefreshUnavailable({ message: `offline: ${url}` })),
    scan: () => Effect.succeed(undefined),
  };
  try {
    await assert.rejects(
      run(refreshAgentRules(root, cache, { offline: true })),
      /cache is unavailable/,
    );
    await assert.rejects(
      run(refreshAgentRules(root, cache, { runtime })),
      /offline.*cache is unavailable/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("online refresh replaces an unreadable cache", async (context) => {
  if (process.getuid?.() === 0) {
    context.skip("requires a non-root test runner");
    return;
  }
  const { cache, root } = createFixture();
  chmodSync(cache, 0o000);
  const runtime: RuleRuntime = {
    fetch: () => Effect.succeed("## General guidelines\n\nRefreshed rules.\n"),
    scan: () => Effect.succeed(undefined),
  };
  try {
    assert.equal(await run(refreshAgentRules(root, cache, { runtime })), "updated");
    assert.equal(readFileSync(cache, "utf8"), "## General guidelines\n\nRefreshed rules.\n");
    assert.equal(statSync(cache).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("refuses a shared-writable or symlinked cache", async () => {
  const { cache, root } = createFixture();
  const target = join(root, "foreign-rules.md");
  writeFileSync(target, originalRules);
  try {
    chmodSync(cache, 0o666);
    await assert.rejects(
      run(refreshAgentRules(root, cache, { offline: true })),
      /not an owner-only regular file/,
    );
    rmSync(cache);
    symlinkSync(target, cache);
    await assert.rejects(
      run(refreshAgentRules(root, cache, { offline: true })),
      /not an owner-only regular file/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
