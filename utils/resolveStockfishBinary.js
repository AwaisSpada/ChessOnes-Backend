const fs = require("fs");
const path = require("path");

/** Reject Git-LFS pointers / tiny placeholders that cause spawn ENOEXEC. */
function isUsableStockfishBinary(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size < 10_000) return false;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    const head = buf.toString("utf8");
    if (head.startsWith("version ")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a real Stockfish binary for the current OS.
 * Linux/Windows files are official Stockfish 19 universal builds, kept at the
 * legacy avx2 filenames so Render/Windows paths stay unchanged.
 * @param {string} stockfishDir Absolute path to project `stockfish/` folder
 */
function resolveStockfishBinary(stockfishDir) {
  const candidates = [];

  if (process.platform === "win32") {
    candidates.push(
      path.join(stockfishDir, "Windows", "stockfish-windows-x86-64-avx2.exe")
    );
  } else if (process.platform === "linux") {
    candidates.push(
      path.join(stockfishDir, "Linux", "stockfish-ubuntu-x86-64-avx2")
    );
  } else if (process.platform === "darwin") {
    candidates.push("/opt/homebrew/bin/stockfish");
    candidates.push("/usr/local/bin/stockfish");
  }

  for (const candidate of candidates) {
    if (isUsableStockfishBinary(candidate)) {
      return candidate;
    }
  }

  return "stockfish";
}

/** Print UCI `id name` on boot so Render `npm run dev` logs show the engine. */
function logStockfishIdentity() {
  const { spawn } = require("child_process");
  const bin = resolveStockfishBinary(path.join(__dirname, "..", "stockfish"));
  console.log(`[Stockfish] Boot probe binary: ${bin}`);

  let child;
  try {
    child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    console.warn(`[Stockfish] Boot probe spawn failed: ${err.message}`);
    return;
  }

  let buf = "";
  let printed = false;
  const done = () => {
    if (printed) return;
    printed = true;
    const lines = buf.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const identity = lines.filter(
      (l) => l.startsWith("id name") || l.startsWith("Stockfish ")
    );
    if (identity.length) {
      identity.forEach((l) => console.log(`[Stockfish] ${l}`));
    } else {
      console.warn("[Stockfish] Boot probe got no id name");
    }
    try {
      child.stdin.write("quit\n");
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };

  const timer = setTimeout(done, 4000);
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    if (buf.includes("id name") || buf.includes("uciok")) {
      clearTimeout(timer);
      done();
    }
  });
  child.stderr.on("data", (chunk) => {
    buf += chunk.toString();
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    console.warn(`[Stockfish] Boot probe error: ${err.message}`);
  });
  try {
    child.stdin.write("uci\n");
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[Stockfish] Boot probe stdin failed: ${err.message}`);
  }
}

module.exports = {
  isUsableStockfishBinary,
  resolveStockfishBinary,
  logStockfishIdentity,
};
