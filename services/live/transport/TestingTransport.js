/**
 * ADR-006 TestingTransport — records ordered calls; no Socket.IO.
 */

class TestingTransport {
  constructor() {
    this.kind = "testing";
    /** @type {Array<{ method: string, args: object }>} */
    this.calls = [];
  }

  _record(method, args) {
    this.calls.push({ method, args });
  }

  clear() {
    this.calls = [];
  }

  emitMoveMade(args) {
    this._record("emitMoveMade", args);
  }

  emitMoveAccepted(args) {
    this._record("emitMoveAccepted", args);
  }

  emitMoveRejected(args) {
    this._record("emitMoveRejected", args);
  }

  emitServerSync(args) {
    this._record("emitServerSync", args);
  }

  emitGameEnded(args) {
    this._record("emitGameEnded", args);
  }

  emitConnectionStatus(args) {
    this._record("emitConnectionStatus", args);
  }
}

module.exports = TestingTransport;
