const { spawnSync } = require("child_process");
const os = require("os");

const BUILDER_IMAGE = "electronuserland/builder:24";
const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push("AppImage", "deb");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

function hasCommand(command, args = ["version"]) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function buildNative() {
  run("npx", ["electron-builder", "--linux", ...targets, "--publish", "never"]);
}

function buildInDocker() {
  if (!hasCommand("docker")) {
    console.error("");
    console.error("Linux AppImage/deb packages cannot be built natively on Windows.");
    console.error("");
    console.error("Options:");
    console.error("  1. Install Docker Desktop, then run: npm run build:linux");
    console.error("  2. Use WSL: npm run build:linux:wsl");
    console.error("  3. Push to main/linux-build and download artifacts from GitHub Actions");
    console.error("");
    process.exit(1);
  }

  const projectDir = process.cwd();
  const builderCmd = [
    "npm ci",
    "npm run icons",
    `npx electron-builder --linux ${targets.join(" ")} --publish never`,
  ].join(" && ");

  console.log(`Building Linux packages in Docker (${BUILDER_IMAGE})...`);

  run("docker", [
    "run",
    "--rm",
    "-i",
    "-v",
    `${projectDir}:/project`,
    "-w",
    "/project",
    BUILDER_IMAGE,
    "/bin/bash",
    "-lc",
    builderCmd,
  ]);
}

const dirOnly = targets.length === 1 && targets[0] === "dir";

if (os.platform() === "linux" || dirOnly) {
  buildNative();
} else {
  buildInDocker();
}
