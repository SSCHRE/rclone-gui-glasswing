const { spawnSync } = require("child_process");
const os = require("os");
const path = require("path");

const BUILDER_IMAGE = "electronuserland/builder:24";
const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push("AppImage", "deb");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    // Avoid shell:true on Windows for docker — cmd.exe splits on && inside -lc payloads.
    shell: options.shell === true,
    env: options.env || process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  const code = result.status ?? 1;
  if (code !== 0) {
    process.exit(code);
  }
}

function hasCommand(command, args = ["version"]) {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function toDockerPath(hostPath) {
  if (process.platform !== "win32") {
    return hostPath;
  }

  const resolved = path.resolve(hostPath);
  const match = /^([A-Za-z]):\\(.*)$/.exec(resolved);
  if (!match) {
    return resolved.replace(/\\/g, "/");
  }

  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function buildNative() {
  run("npm", ["run", "icons"], { shell: process.platform === "win32" });
  run(
    "npx",
    ["electron-builder", "--linux", ...targets, "--publish", "never"],
    { shell: process.platform === "win32" }
  );
}

function buildInDocker() {
  if (!hasCommand("docker")) {
    console.error("");
    console.error("Linux AppImage/deb packages cannot be built natively on Windows.");
    console.error("");
    console.error("Options:");
    console.error("  1. Install Docker Desktop, then run: npm run build:linux");
    console.error("  2. Use WSL: npm run build:linux:wsl");
    console.error("  3. Push to the linux branch and download artifacts from GitHub Actions");
    console.error("");
    process.exit(1);
  }

  const projectDir = toDockerPath(process.cwd());
  const builderCmd = [
    "npm ci",
    "npm run icons",
    `npx electron-builder --linux ${targets.join(" ")} --publish never`,
  ].join(" && ");

  console.log(`Building Linux packages in Docker (${BUILDER_IMAGE})...`);

  // Anonymous volume for node_modules keeps the Linux install off the Windows tree.
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${projectDir}:/project`,
    "-v",
    "/project/node_modules",
    "-w",
    "/project",
    BUILDER_IMAGE,
    "/bin/bash",
    "-lc",
    builderCmd,
  ]);
}

if (os.platform() === "linux") {
  buildNative();
} else {
  buildInDocker();
}
