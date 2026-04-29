const fs = require("fs");
const path = require("path");

// Make Stockfish binary executable on Linux/Unix systems
const stockfishPath = path.join(
  __dirname,
  "..",
  "stockfish",
  "Linux",
  "stockfish-ubuntu-x86-64-avx2"
);

if (fs.existsSync(stockfishPath)) {
  try {
    fs.chmodSync(stockfishPath, 0o755);
    console.log("[Postinstall] Stockfish binary made executable");
  } catch (err) {
    console.warn(
      `[Postinstall] Could not set Stockfish permissions: ${err.message}`
    );
  }
} else {
  console.warn(
    `[Postinstall] Stockfish binary not found at: ${stockfishPath}`
  );
}

