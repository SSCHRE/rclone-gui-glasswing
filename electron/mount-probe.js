const PROBE_TIMEOUT_MS = 20000;
const MAX_DETAIL = 240;

const PROBE_FLAGS = [
  "--max-depth", "1",
  "--dirs-only",
  "--no-modtime",
  "--no-mimetype",
  "--contimeout", "10s",
  "--timeout", "15s",
  "--retries", "1",
  "--low-level-retries", "1",
];

const AUTH_PATTERNS = [
  /invalid_grant/i,
  /invalid_client/i,
  /invalid[_ ]token/i,
  /couldn'?t fetch token/i,
  /failed to get oauth token/i,
  /token (?:has )?expired|expired token|token is expired/i,
  /refresh token/i,
  /oauth2?:/i,
  /\b40[13]\b/,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /authentication (?:failed|required)/i,
  /auth(?:orization)? (?:failed|error)/i,
  /unable to authenticate/i,
  /permission denied \(publickey/i,
  /ssh: handshake failed/i,
  /wrong password|incorrect password|bad password|invalid password/i,
  /password (?:is )?(?:incorrect|wrong|rejected)/i,
  /access ?denied/i,
  /invalid(?:access)?key ?id|signaturedoesnotmatch|invalid credentials|invalid access key/i,
  /credentials? (?:are |is )?(?:invalid|expired|rejected)/i,
  /login (?:failed|required)/i,
  /not authenticated/i,
];

const UNREACHABLE_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /i\/o timeout/i,
  /no such host/i,
  /no route to host/i,
  /network is unreachable/i,
  /connection (?:refused|reset|timed out)/i,
  /dial tcp/i,
  /tls handshake/i,
  /temporary failure in name resolution/i,
  /server misbehaving/i,
  /unexpected eof/i,
  /context deadline exceeded/i,
  /host is down/i,
  /connectex/i,
  /wsarecv|wsasend/i,
  /\bEOF\b/,
  /\b50[234]\b/,
];

function summarise(stderr) {
  const lines = String(stderr || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const severe = lines.filter((line) => /\b(ERROR|CRITICAL)\b/.test(line));
  const noticed = lines.filter((line) => /\bNOTICE\b/.test(line));
  const last = (severe.length ? severe : noticed.length ? noticed : lines).pop() || "";
  const cleaned = last
    .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/, "")
    .replace(/^(NOTICE|ERROR|CRITICAL)\s*:\s*/, "")
    .replace(/^Failed to lsjson:\s*/, "")
    .replace(/^error in ListJSON:\s*/, "")
    .replace(/^Failed to create file system for "[^"]*":\s*/, "")
    .split("<").map((part, index) => (index === 0 ? part : part.slice(part.indexOf(">") + 1))).join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_DETAIL ? `${cleaned.slice(0, MAX_DETAIL).trim()}…` : cleaned;
}

function classifyProbe({ code = 0, stderr = "", timedOut = false } = {}) {
  if (timedOut) {
    return { ok: false, code: "unreachable", detail: "The check timed out." };
  }
  if (code === 0) {
    return { ok: true };
  }
  const text = String(stderr || "");
  const detail = summarise(text);
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) {
    return { ok: false, code: "auth", detail };
  }
  if (UNREACHABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { ok: false, code: "unreachable", detail };
  }
  return { ok: false, code: "other", detail: detail || `rclone exited with code ${code}.` };
}

function probeMessage(result, remote) {
  if (result.code === "auth") {
    return `Your sign-in for ${remote} was rejected.`;
  }
  if (result.code === "unreachable") {
    return `Couldn't reach ${remote}. Check your connection and try again.`;
  }
  return result.detail || `Couldn't check ${remote} before mounting.`;
}

module.exports = { PROBE_TIMEOUT_MS, PROBE_FLAGS, classifyProbe, probeMessage, summarise };
