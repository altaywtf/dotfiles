import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "vite-plus/test";
import { acquireCheckoutLock, converge, syncCheckout } from "./converge.ts";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-converge."));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream");
  const repo = join(root, "checkout");
  mkdirSync(upstream);
  git(upstream, "init", "-b", "main");
  writeFileSync(join(upstream, "policy"), "first\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "first");
  git(root, "clone", upstream, repo);
  const advance = () => {
    writeFileSync(join(upstream, "policy"), "second\n");
    git(upstream, "commit", "-am", "second");
    return git(upstream, "rev-parse", "HEAD");
  };
  return { root, repo, upstream, advance };
}

test("clean default checkout advances and repeat convergence preserves the revision", (t) => {
  const { repo, advance } = fixture(t);
  const next = advance();
  assert.equal(syncCheckout(repo), next);
  assert.equal(readFileSync(join(repo, "policy"), "utf8"), "second\n");
  assert.equal(syncCheckout(repo), next);
});

for (const state of ["dirty", "untracked", "branch", "detached", "ahead", "diverged", "rebase"]) {
  test(`preserves ${state} work without updating the checkout`, (t) => {
    const { repo, advance } = fixture(t);
    if (state !== "ahead") advance();
    if (state === "dirty") writeFileSync(join(repo, "policy"), "local\n");
    if (state === "untracked") writeFileSync(join(repo, "notes"), "keep\n");
    if (state === "branch") git(repo, "checkout", "-b", "feature");
    if (state === "detached") git(repo, "checkout", "--detach");
    if (state === "ahead" || state === "diverged") {
      writeFileSync(join(repo, "policy"), "local\n");
      git(repo, "commit", "-am", "local work");
    }
    if (state === "rebase") mkdirSync(join(repo, ".git/rebase-merge"));
    const before = git(repo, "rev-parse", "HEAD");
    const content = readFileSync(join(repo, "policy"), "utf8");
    assert.throws(() => syncCheckout(repo));
    assert.equal(git(repo, "rev-parse", "HEAD"), before);
    assert.equal(readFileSync(join(repo, "policy"), "utf8"), content);
    if (state === "untracked") assert.equal(readFileSync(join(repo, "notes"), "utf8"), "keep\n");
  });
}

test("failed fetch preserves the checkout and a held lock prevents a second updater", (t) => {
  const { repo, upstream } = fixture(t);
  const before = git(repo, "rev-parse", "HEAD");
  rmSync(upstream, { recursive: true });
  assert.throws(() => syncCheckout(repo));
  assert.equal(git(repo, "rev-parse", "HEAD"), before);
  const lock = join(repo, ".git/dotfiles-converge.lock");
  mkdirSync(lock); // metadata-free lock: the owner is unknown, so it is kept
  assert.throws(() => converge(repo, { waitMs: 0, log: () => {} }), /lock unavailable/);
  assert.ok(existsSync(lock));
});

test("a stale checkout lock is reclaimed and a live one is awaited with backoff", (t) => {
  const { repo } = fixture(t);
  const lock = join(repo, ".git/dotfiles-converge.lock");
  mkdirSync(lock);
  writeFileSync(
    join(lock, "owner.json"),
    `${JSON.stringify({ pid: 4_000_000, bootTime: Date.now() })}\n`,
  );
  const release = acquireCheckoutLock(repo, { processAlive: () => false, log: () => {} });
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid, process.pid);
  release();
  assert.equal(existsSync(lock), false);
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: 1234, bootTime: 0 })}\n`);
  let time = 0;
  const slept: number[] = [];
  const waited = acquireCheckoutLock(repo, {
    now: () => time,
    uptimeMs: () => time,
    processAlive: () => true,
    log: () => {},
    sleep: (ms) => {
      slept.push(ms);
      time += ms;
      if (time >= 30_000) rmSync(lock, { recursive: true, force: true });
    },
  });
  assert.deepEqual(slept, [5_000, 10_000, 20_000]);
  waited();
  assert.equal(existsSync(lock), false);
});

test("bootstrap failure preserves exit status and releases the lock", (t) => {
  const { root, repo, upstream } = fixture(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "mise"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(repo, "dotfiles"), "#!/bin/sh\nexit 23\n", { mode: 0o755 });
  git(repo, "add", "dotfiles");
  git(repo, "commit", "-m", "bootstrap");
  git(upstream, "config", "receive.denyCurrentBranch", "updateInstead");
  git(repo, "push", "origin", "main");
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.onTestFinished(() => {
    process.env.PATH = previousPath;
  });
  assert.throws(() => converge(repo), { exitCode: 23 });
  assert.equal(existsSync(join(repo, ".git/dotfiles-converge.lock")), false);
});

for (const dirty of [false, true]) {
  test(`agent rule checkout ${dirty ? "with local work is kept and reported after maintenance" : "advances before maintenance"}`, (t) => {
    const { root, repo, upstream } = fixture(t);
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "mise"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(repo, "dotfiles"), `#!/bin/sh\ncat "$RULES" > "$RENDERED"\n`, {
      mode: 0o755,
    });
    git(repo, "add", "dotfiles");
    git(repo, "commit", "-m", "bootstrap");
    git(upstream, "config", "receive.denyCurrentBranch", "updateInstead");
    git(repo, "push", "origin", "main");
    const rules = fixture(t);
    const home = join(root, "home");
    mkdirSync(join(home, ".config/dotfiles"), { recursive: true });
    symlinkSync(join(rules.repo, "policy"), join(home, ".config/dotfiles/agents.end.md"));
    chmodSync(join(rules.repo, "policy"), 0o600);
    const next = rules.advance();
    if (dirty) writeFileSync(join(rules.repo, "notes"), "keep\n");
    const before = git(rules.repo, "rev-parse", "HEAD");
    const rendered = join(root, "AGENTS.md");
    const previous = {
      PATH: process.env.PATH,
      RULES: process.env.RULES,
      RENDERED: process.env.RENDERED,
    };
    Object.assign(process.env, {
      PATH: `${bin}:${previous.PATH}`,
      RULES: join(home, ".config/dotfiles/agents.end.md"),
      RENDERED: rendered,
    });
    // Git writes changed files under the umask of an interactive shell.
    const umask = process.umask(0o022);
    t.onTestFinished(() => {
      process.umask(umask);
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    if (dirty) {
      assert.throws(() => converge(repo, {}, home), /agent rule checkouts not updated/);
      assert.equal(git(rules.repo, "rev-parse", "HEAD"), before);
      assert.equal(readFileSync(join(rules.repo, "notes"), "utf8"), "keep\n");
      assert.equal(readFileSync(rendered, "utf8"), "first\n");
    } else {
      converge(repo, {}, home);
      assert.equal(git(rules.repo, "rev-parse", "HEAD"), next);
      assert.equal(readFileSync(rendered, "utf8"), "second\n");
    }
    assert.equal(statSync(join(rules.repo, "policy")).mode & 0o777, 0o600);
  });
}

function runInstall(t: TestContext, args: string[], failure = false) {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-install."));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(import.meta.dirname, "..");
  const log = join(root, "steps");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".config/dotfiles"), { recursive: true });
  writeFileSync(join(root, ".config/dotfiles/llm-gateway.json"), "{}", { mode: 0o600 });
  mkdirSync(join(root, "chezmoi/.chezmoidata"), { recursive: true });
  writeFileSync(
    join(root, "chezmoi/.chezmoidata/profiles.json"),
    readFileSync(join(source, "chezmoi/.chezmoidata/profiles.json")),
  );
  function stub(path: string, name: string) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$TEST_LOG"\nexit ${failure && name === "apply-dotfiles.ts" ? 19 : 0}\n`,
      { mode: 0o755 },
    );
  }
  stub(join(root, "homebrew/brew-bundle.ts"), "brew-bundle.ts");
  for (const name of [
    "apply-dotfiles.ts",
    "install-oh-my-zsh.ts",
    "install-t3-service.ts",
    "trust-agent-worktrees.ts",
    "install-gh-extensions.ts",
    "configure-codex.ts",
    "configure-grok.ts",
    "configure-llm-gateway.ts",
    "configure-hindsight.ts",
  ])
    stub(join(root, "bootstrap", name), name);
  for (const name of ["sync.ts", "plugins.ts", "mcps.ts"]) stub(join(root, "agents", name), name);
  stub(join(bin, "mise"), "mise");
  const result = spawnSync(process.execPath, [join(source, "bootstrap/install.ts"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      DOTFILES_INSTALL_REPO_ROOT: root,
      LLM_GATEWAY_CONFIG: join(root, ".config/dotfiles/llm-gateway.json"),
      TEST_LOG: log,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return { status: result.status, stderr: result.stderr, steps: readFileSync(log, "utf8") };
}

for (const failure of [false, true]) {
  test(`maintenance reuses profile setup with saved logins preserved${failure ? " and stops on failure" : ""}`, (t) => {
    const { status, stderr, steps } = runInstall(
      t,
      ["--profile", "personal-devbox", "--maintenance"],
      failure,
    );
    assert.equal(status, failure ? 19 : 0, stderr);
    if (process.platform === "darwin")
      assert.match(steps, /^brew-bundle.ts --maintenance personal-devbox$/m);
    else assert.doesNotMatch(steps, /brew-bundle/);
    assert.doesNotMatch(steps, /--retire-auth/);
    assert.doesNotMatch(steps, /install-t3-service/);
    if (failure) assert.doesNotMatch(steps, /install-runtimes|mise|sync.ts|configure-codex/);
    else {
      assert.match(steps, /^mise install$/m);
      assert.match(steps, /^mise run dotfiles:runtime-packages$/m);
      assert.match(steps, /^configure-llm-gateway.ts --maintenance$/m);
      // Gateway restoration can replace Grok's config, so defaults apply after it.
      assert.ok(
        steps.indexOf("configure-grok.ts --profile personal-devbox") >
          steps.indexOf("configure-llm-gateway.ts"),
      );
      assert.match(steps, /^plugins.ts --profile personal-devbox --update$/m);
      assert.match(steps, /^sync.ts --profile personal-devbox --update$/m);
      assert.match(steps, /^mcps.ts --profile personal-devbox$/m);
      assert.match(steps, /^configure-hindsight.ts --check$/m);
    }
  });
}

test("setup hands the profile to the T3 service step", (t) => {
  const { status, stderr, steps } = runInstall(t, ["--profile", "personal-devbox"]);
  assert.equal(status, 0, stderr);
  assert.match(steps, /^install-t3-service.ts --profile personal-devbox$/m);
});
