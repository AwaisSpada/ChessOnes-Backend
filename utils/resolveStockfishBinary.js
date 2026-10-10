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

module.exports = {
  isUsableStockfishBinary,
  resolveStockfishBinary,
};
