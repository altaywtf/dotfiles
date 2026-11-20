export function ageIdentityPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.SOPS_AGE_KEY_FILE) {
    return env.SOPS_AGE_KEY_FILE;
  }
  if (env.XDG_CONFIG_HOME) {
    return `${env.XDG_CONFIG_HOME}/sops/age/keys.txt`;
  }
  const home = env.HOME || "";
  return platform === "darwin"
    ? `${home}/Library/Application Support/sops/age/keys.txt`
    : `${home}/.config/sops/age/keys.txt`;
}
