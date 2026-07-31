const { spawnSync } = require("child_process");

const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push("AppImage", "deb");
}

const projectDir = process.cwd().replace(/\\/g, "/").replace(/'/g, "'\\''");
const builderCmd = [
  `cd "$(wslpath '${projectDir}')"`,
  "npm ci",
  "npm run icons",
  `npx electron-builder --linux ${targets.join(" ")} --publish never`,
].join(" && ");

const result = spawnSync("wsl", ["bash", "-lc", builderCmd], {
  stdio: "inherit",
  shell: true,
});

if (result.error) {
  console.error("");
  console.error("WSL is not available. Install WSL or use Docker Desktop:");
  console.error("  npm run build:linux");
  console.error("");
  process.exit(1);
}

process.exit(result.status ?? 1);
