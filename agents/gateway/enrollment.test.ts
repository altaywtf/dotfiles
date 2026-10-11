import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";

import { configureGateway } from "./enrollment.ts";

for (const mode of ["setup", "maintenance"] as const) {
  for (const invalid of ["missing", "symlink", "permissions", "contents"] as const) {
    test(`${mode} rejects ${invalid} gateway input before changing the home`, async (t) => {
      const home = mkdtempSync(join(tmpdir(), "dotfiles-enrollment-"));
      t.onTestFinished(() => {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      });
      const config = join(home, "gateway.json");
      if (invalid !== "missing") writeFileSync(config, "{}", { mode: 0o600 });
      if (invalid === "symlink") {
        rmSync(config);
        symlinkSync(join(home, "absent"), config);
      }
      if (invalid === "permissions") chmodSync(config, 0o644);
      const sentinel = join(home, "saved-login");
      writeFileSync(sentinel, "preserved", { mode: 0o600 });
      const before = readdirSync(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("CODEX_HOME", join(home, ".codex"));
      vi.stubEnv("LLM_GATEWAY_CONFIG", config);
      await assert.rejects(configureGateway(mode), /gateway config/);
      assert.deepEqual(readdirSync(home), before);
      assert.equal(readFileSync(sentinel, "utf8"), "preserved");
    });
  }
}
