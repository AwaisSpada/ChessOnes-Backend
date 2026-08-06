/**
 * ADR-006 / ADR-007 architecture tests (Architecture Test Plan excerpts).
 */

const {
  createGameTransport,
  setGameTransport,
  TestingTransport,
} = require("../transport");
const { EventBus } = require("../events/EventBus");
const {
  createDomainEvent,
  ORIGIN,
  EVENT_TYPE,
} = require("../events/DomainEvent");
const DirtyGame = require("../events/DirtyGame");
const projections = require("../events/projections");

describe("ADR-006 GameTransport", () => {
  test("TestingTransport records ordered emits", () => {
    const t = createGameTransport({ mode: "testing" });
    expect(t.kind).toBe("testing");
    t.emitMoveMade({ gameId: "g1", payload: { a: 1 } });
    t.emitMoveAccepted({
      gameId: "g1",
      userId: "u1",
      payload: { ok: true },
    });
    t.emitGameEnded({ gameId: "g1", payload: { result: {} } });
    expect(t.calls.map((c) => c.method)).toEqual([
      "emitMoveMade",
      "emitMoveAccepted",
      "emitGameEnded",
    ]);
  });

  test("createGameTransport socket requires io", () => {
    expect(() => createGameTransport({ mode: "socket" })).toThrow(/io/);
  });
});

describe("ADR-007 EventBus", () => {
  test("handlers run sequentially in registration order", async () => {
    const bus = new EventBus();
    const order = [];
    bus.subscribe("MOVE_APPLIED", async () => {
      order.push("projection");
    });
    bus.subscribe("MOVE_APPLIED", async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("persist");
    });
    bus.subscribe("MOVE_APPLIED", async () => {
      order.push("scheduler");
    });
    await bus.publish(
      createDomainEvent({
        eventType: "MOVE_APPLIED",
        gameId: "g1",
        origin: ORIGIN.WS,
        syncVersion: 1,
      })
    );
    expect(order).toEqual(["projection", "persist", "scheduler"]);
  });

  test("handler failure does not abort remaining subscribers", async () => {
    const bus = new EventBus();
    const order = [];
    bus.subscribe("X", async () => {
      order.push("a");
      throw new Error("boom");
    });
    bus.subscribe("X", async () => {
      order.push("b");
    });
    await bus.publish(
      createDomainEvent({
        eventType: "X",
        gameId: "g1",
        origin: ORIGIN.System,
      })
    );
    expect(order).toEqual(["a", "b"]);
  });

  test("origin must be allowed", () => {
    expect(() =>
      createDomainEvent({
        eventType: EVENT_TYPE.MOVE_APPLIED,
        gameId: "g1",
        origin: "Client",
      })
    ).toThrow(/origin/);
  });
});

describe("ADR-007 DirtyGame", () => {
  beforeEach(() => DirtyGame._resetForTests());

  test("mark increments failCount and clear removes", () => {
    DirtyGame.mark("g1", { syncVersion: 3, error: new Error("fail") });
    expect(DirtyGame.get("g1").failCount).toBe(1);
    expect(DirtyGame.get("g1").dirty).toBe(true);
    DirtyGame.mark("g1", { syncVersion: 4 });
    expect(DirtyGame.get("g1").failCount).toBe(2);
    DirtyGame.clear("g1");
    expect(DirtyGame.get("g1")).toBeNull();
  });
});

describe("ADR-007 Projection uses GameTransport", () => {
  test("projectMoveApplied emits public DTOs only", () => {
    const t = new TestingTransport();
    setGameTransport(t);
    projections.projectMoveApplied(
      createDomainEvent({
        eventType: EVENT_TYPE.MOVE_APPLIED,
        gameId: "g1",
        origin: ORIGIN.HTTP,
        syncVersion: 2,
        payload: {
          moveMade: { gameId: "g1", move: { from: 1 } },
          moveAccepted: { ok: true, requestId: "r1" },
          userId: "u1",
        },
      })
    );
    expect(t.calls[0].method).toBe("emitMoveMade");
    expect(t.calls[1].method).toBe("emitMoveAccepted");
  });
});
