/**
 * liveSideEffects: GameTransport path (LIVE_DOMAIN_EVENTS off).
 */

describe("liveSideEffects transport path", () => {
  let transport;
  let liveSideEffects;
  let setGameTransport;
  let createGameTransport;

  beforeEach(() => {
    jest.resetModules();
    process.env.LIVE_DOMAIN_EVENTS = "false";
    jest.doMock("../PersistenceQueue", () => ({
      enqueueLiveGamePersist: jest.fn().mockResolvedValue(undefined),
    }));
    ({ createGameTransport, setGameTransport } = require("../transport"));
    liveSideEffects = require("../liveSideEffects");
    transport = createGameTransport({ mode: "testing" });
    setGameTransport(transport);
  });

  afterEach(() => {
    jest.dontMock("../PersistenceQueue");
  });

  test("afterMoveApplied emits move-made then accept", async () => {
    const live = {
      gameId: "g1",
      syncVersion: 2,
      status: "active",
      result: null,
      currentTurn: "black",
      ply: 1,
      rescheduleClocks: jest.fn(),
    };

    await liveSideEffects.afterMoveApplied({
      live,
      origin: "HTTP",
      moveMade: { gameId: "g1", n: 1 },
      moveAccepted: { ok: true },
      userId: "u1",
      persist: true,
      reschedule: true,
    });

    expect(transport.calls.map((c) => c.method)).toEqual([
      "emitMoveMade",
      "emitMoveAccepted",
    ]);
    expect(live.rescheduleClocks).toHaveBeenCalled();
  });
});
