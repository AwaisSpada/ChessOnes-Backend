/**
 * ADR-006 GameTransport factory + process registry.
 */

const SocketIOTransport = require("./SocketIOTransport");
const TestingTransport = require("./TestingTransport");

/** @type {SocketIOTransport | TestingTransport | null} */
let current = null;

/**
 * @param {{ io?: import("socket.io").Server, mode?: string }} options
 */
function createGameTransport(options = {}) {
  const mode = String(options.mode || "socket").toLowerCase();
  if (mode === "testing" || mode === "test") {
    return new TestingTransport();
  }
  if (!options.io) {
    throw new Error("createGameTransport(socket) requires options.io");
  }
  return new SocketIOTransport(options.io);
}

function setGameTransport(transport) {
  current = transport;
  return current;
}

function getGameTransport() {
  if (!current) {
    throw new Error(
      "GameTransport not initialized — call createGameTransport + setGameTransport at boot"
    );
  }
  return current;
}

function tryGetGameTransport() {
  return current;
}

module.exports = {
  createGameTransport,
  setGameTransport,
  getGameTransport,
  tryGetGameTransport,
  SocketIOTransport,
  TestingTransport,
};
