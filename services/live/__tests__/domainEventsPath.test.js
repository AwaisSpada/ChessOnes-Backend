/**
 * Domain-events sole path: Projection → (mocked) persist/schedule order via bus.
 */

describe("liveSideEffects domain events path", () => {
  let transport;
  let liveSideEffects;
  let events;
  let LiveGameManager;

  beforeEach(() => {
    jest.resetModules();
    process.env.LIVE_DOMAIN_EVENTS = "true";
    jest.doMock("../PersistenceQueue", () => ({
      enqueueLiveGamePersist: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock("../ClockScheduler", () => ({
      isArmed: () => true,
      rescheduleAll: jest.fn(),
      cancel: jest.fn(),
    }));

    const transportMod = require("../transport");
    transport = transportMod.createGameTransport({ mode: "testing" });
    transportMod.setGameTransport(transport);

    events = require("../events");
    events.bus.clear();
    events.initLiveDomainEvents();

    LiveGameManager = require("../LiveGameManager");
    liveSideEffects = require("../liveSideEffects");
  });

  afterEach(() => {
    jest.dontMock("../PersistenceQueue");
    jest.dontMock("../ClockScheduler");
  });

  test("MOVE_APPLIED projects before calling persist mock", async () => {
    const live = {
      gameId: "g-de",
      syncVersion: 5,
      status: "active",
      result: null,
      currentTurn: "white",
      ply: 0,
      rescheduleClocks: jest.fn(),
    };
    jest.spyOn(LiveGameManager, "get").mockReturnValue(live);

    const PersistenceQueue = require("../PersistenceQueue");
    const ClockScheduler = require("../ClockScheduler");

    await liveSideEffects.afterMoveApplied({
      live,
      origin: "WS",
      moveMade: { gameId: "g-de", n: 1 },
      moveAccepted: { ok: true, requestId: "r1" },
      userId: "u1",
      requestId: "r1",
    });

    expect(transport.calls.map((c) => c.method)).toEqual([
      "emitMoveMade",
      "emitMoveAccepted",
    ]);
    expect(PersistenceQueue.enqueueLiveGamePersist).toHaveBeenCalled();
    expect(ClockScheduler.rescheduleAll).toHaveBeenCalledWith(live);
    expect(live.rescheduleClocks).not.toHaveBeenCalled();
  });
});
