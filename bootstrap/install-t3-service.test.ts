import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Effect, FileSystem } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { installT3Service } from "./install-t3-service.ts";

const home = "/home/test";
function fixture(
  options: {
    optIn?: string;
    unreadable?: boolean;
    present?: boolean;
    linger?: string;
    pid?: string;
    environ?: string;
    installStatus?: number;
    writesUnit?: boolean;
    reportedStatus?: string;
  } = {},
) {
  let present = options.present ?? false;
  const calls: string[][] = [];
  const reads: string[] = [];
  const fs = FileSystem.makeNoop({
    exists: () => Effect.succeed(present),
    ...(!options.unreadable
      ? {
          readFileString: (path: string) => {
            reads.push(path);
            return Effect.succeed(
              path.endsWith("devbox.env")
                ? (options.optIn ?? "T3_SERVICE=1\n")
                : (options.environ ??
                    `HOME=${home}\0PATH=${home}/.local/share/mise/shims:/usr/bin\0`),
            );
          },
        }
      : {}),
  });
  const runner = CommandRunner.of({
    run: (command, args = []) => {
      calls.push([command, ...args]);
      let stdout = "";
      let status = 0;
      if (command === "loginctl") stdout = options.linger ?? "yes\n";
      if (command === "systemctl") stdout = options.pid ?? "123\n";
      if (command === "t3" && args[1] === "install") {
        present = options.writesUnit ?? true;
        status = options.installStatus ?? 0;
      }
      if (command === "t3" && args[1] === "status")
        stdout = options.reportedStatus ?? "Status: installed\n";
      return Effect.succeed({ status, stdout, stderr: "" });
    },
  });
  const run = (check = false, platform: NodeJS.Platform = "linux", byDefault = false) =>
    Effect.runPromise(
      installT3Service(home, check, byDefault, platform, 1000, `${home}/.t3`).pipe(
        Effect.provideService(CommandRunner, runner),
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );
  return { calls, reads, run };
}

for (const options of [
  { optIn: "" },
  { optIn: "# T3_SERVICE=1\nT3_SERVICE=0\n" },
  { unreadable: true },
]) {
  test(`opt-in profile without T3_SERVICE=1 skips T3 operations (${JSON.stringify(options)})`, async () => {
    const f = fixture(options);
    await f.run();
    await f.run(true);
    assert.deepEqual(f.calls, []);
  });
}

test("default-on profile installs without a devbox.env", async () => {
  const f = fixture({ unreadable: true });
  await f.run(false, "linux", true);
  assert.deepEqual(f.calls.at(-1), ["t3", "service", "install", "--base-dir", `${home}/.t3`]);
});

test("T3_SERVICE=0 opts a default-on profile out", async () => {
  const f = fixture({ optIn: "T3_SERVICE=1\nT3_SERVICE=0\n" });
  await f.run(false, "linux", true);
  await f.run(true, "linux", true);
  assert.deepEqual(f.calls, []);
});

test("opt-in tolerates unrelated lines and CRLF", async () => {
  const f = fixture({ optIn: "OTHER=value\r\nT3_SERVICE=1\r\n", present: true });
  await f.run(false, "darwin");
  assert.deepEqual(f.calls, []);
});

test("checking a missing installation fails without installing", async () => {
  const f = fixture();
  await assert.rejects(f.run(true), /not installed/);
  assert.deepEqual(f.calls, []);
});

test("existing macOS service is accepted without starting or replacing it", async () => {
  const f = fixture({ present: true });
  await f.run(false, "darwin");
  await f.run(true, "darwin");
  assert.deepEqual(f.calls, []);
});

test("existing Linux service still requires lingering without reinstalling", async () => {
  const f = fixture({ present: true });
  await f.run();
  assert.deepEqual(f.calls, [["loginctl", "show-user", "1000", "--property=Linger", "--value"]]);
});

for (const present of [false, true]) {
  test(`Linux lingering prevents ${present ? "accepting" : "installing"} the service`, async () => {
    const f = fixture({ present, linger: "no\n" });
    await assert.rejects(f.run(), /lingering/);
    assert.ok(f.calls.every((call) => call[0] !== "t3"));
  });
}

test("Linux check proves running-process PATH and lingering", async () => {
  const f = fixture({ present: true });
  await f.run(true);
  assert.ok(f.reads.includes("/proc/123/environ"));
  assert.deepEqual(f.calls, [
    ["systemctl", "--user", "show", "-p", "MainPID", "--value", "t3code.service"],
    ["loginctl", "show-user", "1000", "--property=Linger", "--value"],
  ]);
});

for (const pid of ["0\n", "invalid\n"]) {
  test(`Linux check rejects a non-running service (${pid.trim()})`, async () => {
    const f = fixture({ present: true, pid });
    await assert.rejects(f.run(true), /not running/);
    assert.ok(f.reads.every((path) => !path.startsWith("/proc/")));
  });
}

test("Linux check requires the exact shim directory in the running PATH", async () => {
  const f = fixture({
    present: true,
    environ: `PATH=${home}/.local/share/mise/shims-extra:/usr/bin\0`,
  });
  await assert.rejects(f.run(true), /PATH lacks the mise shims/);
  assert.ok(f.calls.every((call) => call[0] !== "t3"));
});

test("missing opted-in Linux service installs after the linger check", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls, [
    ["loginctl", "show-user", "1000", "--property=Linger", "--value"],
    ["t3", "service", "install", "--base-dir", `${home}/.t3`],
  ]);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`failed ${platform} installation without a unit remains a failure`, async () => {
    const f = fixture({ installStatus: 17, writesUnit: false });
    await assert.rejects(f.run(false, platform), /exited 17/);
  });
  test(`successful ${platform} command without a unit is rejected`, async () => {
    const f = fixture({ writesUnit: false });
    await assert.rejects(f.run(false, platform), /is missing/);
  });
}

test("headless macOS failure is deferred only with T3 installed-status evidence", async () => {
  const f = fixture({ installStatus: 1 });
  await f.run(false, "darwin");
  assert.deepEqual(f.calls, [
    ["t3", "service", "install", "--base-dir", `${home}/.t3`],
    ["t3", "service", "status", "--base-dir", `${home}/.t3`],
  ]);
  const corrupt = fixture({ installStatus: 1, reportedStatus: "Status: broken\n" });
  await assert.rejects(corrupt.run(false, "darwin"), /exited 1/);
});

test("Linux cannot defer failed installation even when the unit was written", async () => {
  const f = fixture({ installStatus: 1 });
  await assert.rejects(f.run(), /exited 1/);
  assert.ok(f.calls.every((call) => call[2] !== "status"));
});
