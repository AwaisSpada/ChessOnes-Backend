/**
 * ADR-007 subscribers — emit / persist / schedule / metrics only.
 * Never mutate LiveGame board, clocks, turns, status, or syncVersion.
 */

const PersistenceQueue = require("../PersistenceQueue");
const ClockScheduler = require("../ClockScheduler");
const LiveGameManager = require("../LiveGameManager");
const DirtyGame = require("./DirtyGame");
const projections = require("./projections");
const { EVENT_TYPE } = require("./DomainEvent");
const { subscribe } = require("./EventBus");

async function persistFromEvent(event) {
  const live = LiveGameManager.get(event.gameId);
  if (!live) return;
  try {
    await PersistenceQueue.enqueueLiveGamePersist(live);
    DirtyGame.clear(event.gameId);
  } catch (err) {
    DirtyGame.mark(event.gameId, {
      syncVersion: event.syncVersion,
      error: err,
    });
    console.error(
      `[PersistenceSubscriber] persist failed game=${event.gameId}:`,
      err?.message || err
    );
  }
}

function scheduleFromEvent(event) {
  const live = LiveGameManager.get(event.gameId);
  if (!live) {
    if (ClockScheduler.isArmed()) {
      ClockScheduler.cancel(event.gameId);
    }
    return;
  }
  if (!ClockScheduler.isArmed()) return;
  if (
    event.eventType === EVENT_TYPE.GAME_ENDED ||
    event.eventType === EVENT_TYPE.TIMEOUT_OCCURRED ||
    event.eventType === EVENT_TYPE.ABANDON_OCCURRED ||
    event.eventType === EVENT_TYPE.GAME_EVICTED ||
    live.status !== "active"
  ) {
    ClockScheduler.cancel(event.gameId);
    return;
  }
  ClockScheduler.rescheduleAll(live);
}

/**
 * Registration order = execution order: Projection → Persistence → Scheduler.
 */
function registerLiveSubscribers() {
  // Projection first
  subscribe(EVENT_TYPE.MOVE_APPLIED, async (e) => projections.projectMoveApplied(e));
  subscribe(EVENT_TYPE.MOVE_REJECTED, async (e) => projections.projectMoveRejected(e));
  subscribe(EVENT_TYPE.GAME_ENDED, async (e) => projections.projectGameEnded(e));
  subscribe(EVENT_TYPE.TIMEOUT_OCCURRED, async (e) =>
    projections.projectTimeoutOrAbandon(e)
  );
  subscribe(EVENT_TYPE.ABANDON_OCCURRED, async (e) =>
    projections.projectTimeoutOrAbandon(e)
  );
  subscribe(EVENT_TYPE.SERVER_SYNC_SENT, async (e) =>
    projections.projectServerSync(e)
  );
  subscribe(EVENT_TYPE.PLAYER_RECONNECTED, async (e) =>
    projections.projectPlayerConnection(e)
  );
  subscribe(EVENT_TYPE.PLAYER_DISCONNECTED, async (e) =>
    projections.projectPlayerConnection(e)
  );

  // Persistence second
  subscribe(EVENT_TYPE.MOVE_APPLIED, persistFromEvent);
  subscribe(EVENT_TYPE.GAME_ENDED, persistFromEvent);
  subscribe(EVENT_TYPE.TIMEOUT_OCCURRED, persistFromEvent);
  subscribe(EVENT_TYPE.ABANDON_OCCURRED, persistFromEvent);

  // Scheduler third
  subscribe(EVENT_TYPE.MOVE_APPLIED, async (e) => scheduleFromEvent(e));
  subscribe(EVENT_TYPE.GAME_STARTED, async (e) => scheduleFromEvent(e));
  subscribe(EVENT_TYPE.GAME_ENDED, async (e) => scheduleFromEvent(e));
  subscribe(EVENT_TYPE.TIMEOUT_OCCURRED, async (e) => scheduleFromEvent(e));
  subscribe(EVENT_TYPE.ABANDON_OCCURRED, async (e) => scheduleFromEvent(e));
  subscribe(EVENT_TYPE.GAME_HYDRATED, async (e) => scheduleFromEvent(e));
  subscribe(EVENT_TYPE.GAME_EVICTED, async (e) => {
    DirtyGame.clear(e.gameId);
    scheduleFromEvent(e);
  });
  subscribe(EVENT_TYPE.PLAYER_RECONNECTED, async (e) => scheduleFromEvent(e));
}

module.exports = {
  registerLiveSubscribers,
  persistFromEvent,
  scheduleFromEvent,
};
