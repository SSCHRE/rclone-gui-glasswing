const { spawn } = require("child_process");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { path7za } = require("7zip-bin");

const SEVEN_Z_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const ENTRY_LIMIT = 5000;

const NID = {
  End: 0x00,
  Header: 0x01,
  PackInfo: 0x06,
  Size: 0x09,
  CRC: 0x0a,
  EncodedHeader: 0x17,
};

function resolve7zaPath() {
  let binary = path7za;
  if (binary.includes("app.asar")) {
    binary = binary.replace("app.asar", "app.asar.unpacked");
  }
  if (!fsSync.existsSync(binary)) {
    throw new Error("Bundled 7-Zip binary was not found.");
  }
  return binary;
}

function readUInt64LE(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset));
}

function readNumber(buf, cursor) {
  const firstByte = buf[cursor.pos++];
  let mask = 0x80;
  let value = 0n;
  for (let i = 0; i < 8; i += 1) {
    if ((firstByte & mask) === 0) {
      value += BigInt(firstByte & (mask - 1)) << BigInt(8 * i);
      return Number(value);
    }
    value |= BigInt(buf[cursor.pos++]) << BigInt(8 * i);
    mask >>= 1;
  }
  return Number(value);
}

function skipDigests(buf, cursor, count) {
  const allDefined = buf[cursor.pos++];
  let defined = count;
  if (allDefined === 0) {
    const bitBytes = Math.ceil(count / 8);
    let ones = 0;
    for (let i = 0; i < bitBytes; i += 1) {
      const bits = buf[cursor.pos++];
      for (let b = 0; b < 8; b += 1) {
        if (i * 8 + b < count && bits & (0x80 >> b)) {
          ones += 1;
        }
      }
    }
    defined = ones;
  }
  cursor.pos += defined * 4;
}

/** Parse PackInfo and stop; remaining StreamsInfo is unused for sparse stubs. */
function parsePackInfo(buf, cursor) {
  const packPos = readNumber(buf, cursor);
  const numPackStreams = readNumber(buf, cursor);
  const packSizes = [];

  for (;;) {
    const nid = buf[cursor.pos++];
    if (nid === NID.End) {
      break;
    }
    if (nid === NID.Size) {
      for (let i = 0; i < numPackStreams; i += 1) {
        packSizes.push(readNumber(buf, cursor));
      }
      continue;
    }
    if (nid === NID.CRC) {
      skipDigests(buf, cursor, numPackStreams);
      continue;
    }
    throw new Error("Unsupported 7z PackInfo property.");
  }

  if (packSizes.length === 0) {
    throw new Error("7z PackInfo is missing sizes.");
  }

  return { packPos, packSizes };
}

function findEncodedHeaderPack(nextHeader) {
  if (!nextHeader?.length) {
    throw new Error("Missing 7z header.");
  }

  // Uncompressed header: no extra pack streams needed for listing.
  if (nextHeader[0] === NID.Header) {
    return null;
  }

  if (nextHeader[0] !== NID.EncodedHeader) {
    throw new Error("Unsupported 7z header type.");
  }

  // Encoded headers only need PackInfo for a list-capable sparse stub.
  // UnpackInfo/SubStreamsInfo are decoded by 7za from the fetched pack bytes.
  const cursor = { pos: 1 };
  if (nextHeader[cursor.pos++] !== NID.PackInfo) {
    throw new Error("Encoded 7z header is missing pack info.");
  }
  return parsePackInfo(nextHeader, cursor);
}

function parseSevenZStartHeader(buffer) {
  if (!buffer || buffer.length < 32) {
    throw new Error("Not a valid 7z archive.");
  }
  if (!buffer.subarray(0, 6).equals(SEVEN_Z_SIGNATURE)) {
    throw new Error("Not a valid 7z archive.");
  }

  const nextHeaderOffset = readUInt64LE(buffer, 12);
  const nextHeaderSize = readUInt64LE(buffer, 20);
  if (!Number.isFinite(nextHeaderOffset) || !Number.isFinite(nextHeaderSize)) {
    throw new Error("Invalid 7z header offsets.");
  }
  if (nextHeaderSize <= 0 || nextHeaderSize > MAX_HEADER_BYTES) {
    throw new Error("7z header is too large to preview.");
  }

  return {
    nextHeaderOffset,
    nextHeaderSize,
    headerAbsOffset: 32 + nextHeaderOffset,
  };
}

function parseSevenZListOutput(stdout) {
  const blocks = String(stdout || "")
    .replace(/\r\n/g, "\n")
    .split(/\n(?=Path = )/);

  const entries = [];
  let truncated = false;

  for (const block of blocks) {
    const fields = {};
    for (const line of block.split("\n")) {
      const sep = line.indexOf(" = ");
      if (sep <= 0) {
        continue;
      }
      fields[line.slice(0, sep).trim()] = line.slice(sep + 3).trim();
    }

    const name = (fields.Path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name === ".") {
      continue;
    }

    const attributes = fields.Attributes || "";
    const folderFlag = fields.Folder === "+" || /^D/i.test(attributes) || name.endsWith("/");
    const size = Number.parseInt(fields.Size || "0", 10);
    const packed = Number.parseInt(fields["Packed Size"] || "0", 10);

    if (entries.length >= ENTRY_LIMIT) {
      truncated = true;
      break;
    }

    entries.push({
      name: name.replace(/\/+$/, ""),
      size: folderFlag || !Number.isFinite(size) ? null : size,
      compressedSize: folderFlag || !Number.isFinite(packed) ? null : packed,
      isDir: Boolean(folderFlag),
    });
  }

  entries.sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  return {
    entries,
    totalEntries: truncated ? entries.length + 1 : entries.length,
    truncated,
  };
}

function run7zaList(archivePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolve7zaPath(), ["l", "-slt", "-ba", archivePath], {
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `7z list failed (code ${code ?? "?"}).`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function writeSparse7zStub(filePath, archiveSize, regions) {
  await fs.writeFile(filePath, Buffer.alloc(0));
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.truncate(archiveSize);
    for (const region of regions) {
      await handle.write(region.data, 0, region.data.length, region.offset);
    }
  } finally {
    await handle.close();
  }
}

async function listSevenZEntriesFromRemote(source, archiveSize, { fetchRange, fetchTail }) {
  if (!Number.isFinite(archiveSize) || archiveSize < 32) {
    throw new Error("Not a valid 7z archive.");
  }

  const startHeader = await fetchRange(source, 0, 32, { timeoutMs: 60000 });
  const { nextHeaderSize, headerAbsOffset } = parseSevenZStartHeader(startHeader);

  if (headerAbsOffset < 32 || headerAbsOffset + nextHeaderSize > archiveSize) {
    throw new Error("Invalid 7z header location.");
  }

  const fromEnd = archiveSize - headerAbsOffset;
  const endSlice = await fetchTail(source, fromEnd, { timeoutMs: 180000 });
  if (endSlice.length < nextHeaderSize) {
    throw new Error("Failed to read 7z header.");
  }
  const nextHeader = Buffer.from(endSlice.subarray(0, nextHeaderSize));

  const regions = [
    { offset: 0, data: startHeader },
    { offset: headerAbsOffset, data: nextHeader },
  ];

  const packInfo = findEncodedHeaderPack(nextHeader);
  if (packInfo) {
    const packAbs = 32 + packInfo.packPos;
    const packBytes = packInfo.packSizes.reduce((sum, size) => sum + size, 0);
    if (packAbs < 32 || packBytes <= 0 || packAbs + packBytes > archiveSize) {
      throw new Error("Invalid 7z encoded-header pack location.");
    }
    if (packBytes > MAX_HEADER_BYTES) {
      throw new Error("7z encoded header pack is too large to preview.");
    }

    let packData;
    const packFromEnd = archiveSize - packAbs;
    if (packFromEnd >= packBytes && packFromEnd <= MAX_HEADER_BYTES * 2) {
      const slice = await fetchTail(source, packFromEnd, { timeoutMs: 180000 });
      packData = slice.subarray(0, packBytes);
    } else {
      packData = await fetchRange(source, packAbs, packBytes, { timeoutMs: 180000 });
    }

    if (packData.length < packBytes) {
      throw new Error("Failed to read 7z encoded header pack.");
    }
    regions.push({ offset: packAbs, data: Buffer.from(packData.subarray(0, packBytes)) });
  }

  const tmpDir = path.join(os.tmpdir(), "glasswing-7z-preview", randomUUID());
  const stubPath = path.join(tmpDir, "preview.7z");

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await writeSparse7zStub(stubPath, archiveSize, regions);
    return parseSevenZListOutput(await run7zaList(stubPath));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  listSevenZEntriesFromRemote,
  ENTRY_LIMIT,
};
