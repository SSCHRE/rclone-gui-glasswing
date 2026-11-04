const { spawn } = require("child_process");
const net = require("net");
const os = require("os");

const PROTOCOLS = Object.freeze({
  http: Object.freeze({ command: "http", label: "HTTP", scheme: "http", defaultPort: 8080, browsable: true, requiresAuth: false }),
  webdav: Object.freeze({ command: "webdav", label: "WebDAV", scheme: "http", defaultPort: 8080, browsable: true, requiresAuth: false }),
  ftp: Object.freeze({ command: "ftp", label: "FTP", scheme: "ftp", defaultPort: 2121, browsable: false, requiresAuth: false }),
  sftp: Object.freeze({ command: "sftp", label: "SFTP", scheme: "sftp", defaultPort: 2022, browsable: false, requiresAuth: true }),
});
const CACHE_MODE_FLAGS = Object.freeze({
  off: "--vfs-cache-mode=off",
  minimal: "--vfs-cache-mode=minimal",
  writes: "--vfs-cache-mode=writes",
  full: "--vfs-cache-mode=full",
});
const LISTEN_HOSTS = Object.freeze({
  local: "127.0.0.1",
  network: "0.0.0.0",
});
const SERVE_READY_TIMEOUT_MS = 30000;
const SERVE_READY_POLL_MS = 250;
const PROBE_TIMEOUT_MS = 1000;
const STOP_TIMEOUT_MS = 5000;
const STDERR_TAIL_BYTES = 4096;
const MAX_CREDENTIAL_LENGTH = 256;

const serves = new Map();

function listProtocols() {
  return Object.entries(PROTOCOLS).map(([id, protocol]) => ({
    id,
    label: protocol.label,
    defaultPort: protocol.defaultPort,
    browsable: protocol.browsable,
    requiresAuth: protocol.requiresAuth,
  }));
}

function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      const isIpv4 = address.family === "IPv4" || address.family === 4;
      if (isIpv4 && !address.internal && !address.address.startsWith("169.254.")) {
        return address.address;
      }
    }
  }
  return os.hostname();
}

function buildUrl(protocol, host, port) {
  const suffix = protocol.scheme === "http" ? "/" : "";
  return `${protocol.scheme}://${host}:${port}${suffix}`;
}

function describeServe(serve) {
  return {
    id: serve.port,
    remote: serve.remote,
    path: serve.path,
    protocol: serve.protocolId,
    label: serve.protocol.label,
    port: serve.port,
    network: serve.network,
    url: serve.url,
    localUrl: serve.localUrl,
    browsable: serve.protocol.browsable,
    user: serve.user,
    readOnly: serve.readOnly,
    cacheMode: serve.cacheMode,
    startedAt: serve.startedAt,
  };
}

function listServes() {
  return [...serves.values()].filter((serve) => serve.ready).map(describeServe);
}

function getStatus() {
  return {
    protocols: listProtocols(),
    serves: listServes(),
  };
}

function findServe(id) {
  const serve = serves.get(Number(id));
  return serve?.ready ? describeServe(serve) : null;
}

function parsePort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) {
    throw new Error("The port has to be a number between 1 and 65535.");
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new Error("The port has to be a number between 1 and 65535.");
  }
  return port;
}

function hasControlCharacters(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function cleanCredential(value, label) {
  const text = String(value ?? "");
  if (text.length > MAX_CREDENTIAL_LENGTH) {
    throw new Error(`The ${label} is too long.`);
  }
  if (hasControlCharacters(text)) {
    throw new Error(`The ${label} contains characters that aren't allowed.`);
  }
  return text;
}

function ensurePortFree(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        reject(new Error(`Port ${port} is already in use on this computer. Pick another one.`));
      } else {
        reject(error);
      }
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve());
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function redact(text, secret) {
  return secret ? text.split(secret).join("***") : text;
}

function friendlyServeError(stderr, code, secret = "") {
  const text = redact(String(stderr || ""), secret);
  if (/didn't find section in config file|not found in config/i.test(text)) {
    return "This remote no longer exists in your rclone config.";
  }
  if (/address already in use|only one usage of each socket address/i.test(text)) {
    return "That port is already in use. Pick another one.";
  }
  if (/directory not found/i.test(text)) {
    return "That folder doesn't exist on the remote.";
  }

  const lastError = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /ERROR|CRITICAL|Fatal/i.test(line))
    .pop();
  if (lastError) {
    return lastError.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/, "");
  }
  return `rclone serve exited with code ${code ?? "unknown"}.`;
}

async function startServe(
  { remote, path = "", target, protocol, port, network = false, user = "", pass = "", readOnly = true, cacheMode = "off", bwlimit = "" },
  { onExit } = {},
) {
  if (!Object.hasOwn(PROTOCOLS, protocol)) {
    throw new Error(`Unknown protocol "${protocol}".`);
  }
  const protocolDef = PROTOCOLS[protocol];
  if (!Object.hasOwn(CACHE_MODE_FLAGS, cacheMode)) {
    throw new Error(`Unknown cache mode "${cacheMode}".`);
  }
  const cacheModeFlag = CACHE_MODE_FLAGS[cacheMode];
  const host = network ? LISTEN_HOSTS.network : LISTEN_HOSTS.local;
  const portNumber = parsePort(port);
  const userName = cleanCredential(user, "username").trim();
  const password = cleanCredential(pass, "password");

  if (!target) {
    throw new Error("Nothing to serve.");
  }
  if (serves.has(portNumber)) {
    throw new Error(`Port ${portNumber} is already used by another serve.`);
  }
  if (password && !userName) {
    throw new Error("Add a username to go with the password.");
  }
  if (userName && !password) {
    throw new Error("Add a password to go with the username.");
  }
  if (protocolDef.requiresAuth && !userName) {
    throw new Error(`${protocolDef.label} needs a username and password.`);
  }

  const serve = {
    remote,
    path,
    protocolId: protocol,
    protocol: protocolDef,
    port: portNumber,
    network: Boolean(network),
    url: buildUrl(protocolDef, network ? lanAddress() : LISTEN_HOSTS.local, portNumber),
    localUrl: buildUrl(protocolDef, LISTEN_HOSTS.local, portNumber),
    user: userName,
    readOnly: Boolean(readOnly),
    cacheMode,
    startedAt: Date.now(),
    child: null,
    ready: false,
    stopping: false,
    stderr: "",
  };
  serves.set(portNumber, serve);

  try {
    if (await canConnect(portNumber)) {
      throw new Error(`Port ${portNumber} is already in use on this computer. Pick another one.`);
    }
    await ensurePortFree(host, portNumber);
  } catch (error) {
    serves.delete(portNumber);
    throw error;
  }

  const flags = [`--addr=${host}:${portNumber}`, cacheModeFlag];
  if (readOnly) {
    flags.push("--read-only");
  }
  if (userName) {
    flags.push(`--user=${userName}`, `--pass=${password}`);
  }
  if (bwlimit) {
    flags.push(`--bwlimit=${bwlimit}`);
  }

  const args = ["serve", protocolDef.command, ...flags, "--", target];
  const child = spawn("rclone", args, {
    windowsHide: true,
    shell: false,
    env: process.env,
  });
  serve.child = child;

  const appendOutput = (chunk) => {
    serve.stderr = (serve.stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  return new Promise((resolve, reject) => {
    let settled = false;
    let probing = false;

    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      handler();
    };

    const markReady = (listening) => {
      probing = false;
      if (listening && child.exitCode === null) {
        finish(() => {
          serve.ready = true;
          serve.stderr = "";
          resolve(describeServe(serve));
        });
      }
    };

    const poll = setInterval(() => {
      if (probing || settled) {
        return;
      }
      probing = true;
      canConnect(portNumber).then(markReady);
    }, SERVE_READY_POLL_MS);

    const timer = setTimeout(() => {
      finish(() => {
        serves.delete(portNumber);
        serve.stopping = true;
        child.kill();
        reject(new Error(`Timed out waiting for the serve to start. ${friendlyServeError(serve.stderr, null, password)}`));
      });
    }, SERVE_READY_TIMEOUT_MS);

    child.on("error", (error) => {
      finish(() => {
        serves.delete(portNumber);
        reject(error.code === "ENOENT" ? new Error("rclone was not found on your PATH.") : error);
      });
    });

    child.on("close", (code) => {
      const wasReady = serve.ready;
      if (serves.get(portNumber) === serve) {
        serves.delete(portNumber);
      }

      finish(() => reject(new Error(friendlyServeError(serve.stderr, code, password))));

      if (wasReady) {
        onExit?.({
          ...describeServe(serve),
          unexpected: !serve.stopping,
          message: serve.stopping ? "" : friendlyServeError(serve.stderr, code, password),
        });
      }
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopServe(id) {
  const port = Number(id);
  const serve = serves.get(port);
  if (!serve?.child) {
    return { stopped: true };
  }

  serve.stopping = true;
  serve.child.kill();
  if (!(await waitForExit(serve.child, STOP_TIMEOUT_MS))) {
    serve.child.kill("SIGKILL");
    await waitForExit(serve.child, 2000);
  }

  if (serves.get(port) === serve) {
    serves.delete(port);
  }
  return { stopped: true };
}

async function stopAllServes() {
  await Promise.all([...serves.keys()].map((port) => stopServe(port)));
}

function hasServes() {
  return serves.size > 0;
}

module.exports = {
  getStatus,
  listServes,
  findServe,
  startServe,
  stopServe,
  stopAllServes,
  hasServes,
};
