const { execFile } = require("child_process");

const VERB = "GlasswingUpload";
const LABEL = "Upload with Glasswing";
const KEYS = [
  `HKCU\\Software\\Classes\\*\\shell\\${VERB}`,
  `HKCU\\Software\\Classes\\Directory\\shell\\${VERB}`,
];

function reg(args) {
  return new Promise((resolve) => {
    execFile("reg.exe", args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function quote(value) {
  return `"${value}"`;
}

function createExplorerMenu({ executable, appArgs = [], iconPath }) {
  const command = [executable, ...appArgs].map(quote).join(" ") + ' "--upload=%1"';

  async function readCommand(key) {
    const result = await reg(["query", `${key}\\command`, "/ve"]);
    if (!result.ok) {
      return null;
    }
    const match = result.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.*)\s*$/m);
    return match ? match[1].trim() : null;
  }

  async function status() {
    const commands = await Promise.all(KEYS.map(readCommand));
    const enabled = commands.every(Boolean);
    return { enabled, current: enabled && commands.every((value) => value === command) };
  }

  async function enable() {
    for (const key of KEYS) {
      const steps = [
        ["add", key, "/ve", "/d", LABEL, "/f"],
        ["add", key, "/v", "Icon", "/d", iconPath || executable, "/f"],
        ["add", key, "/v", "MultiSelectModel", "/d", "Player", "/f"],
        ["add", `${key}\\command`, "/ve", "/d", command, "/f"],
      ];
      for (const step of steps) {
        const result = await reg(step);
        if (!result.ok) {
          throw new Error(result.stderr.trim() || "Windows didn't let Glasswing change the Explorer menu.");
        }
      }
    }
  }

  async function disable() {
    for (const key of KEYS) {
      await reg(["delete", key, "/f"]);
    }
  }

  return { status, enable, disable, command };
}

function uploadPathsFromArgv(argv) {
  const paths = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--upload=") && argv[index].length > 9) {
      paths.push(argv[index].slice(9));
    } else if (argv[index] === "--upload" && argv[index + 1]) {
      paths.push(argv[index + 1]);
      index += 1;
    }
  }
  return paths;
}

module.exports = { createExplorerMenu, uploadPathsFromArgv, LABEL };
