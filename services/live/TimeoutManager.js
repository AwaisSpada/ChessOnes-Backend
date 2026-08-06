/**
 * Phase 3 TimeoutManager — chess flag execution only.
 * Revalidates LiveGame under mutation lock on every fire. No abandon / clocks ownership.
 */

const LiveGameManager = require("./LiveGameManager");
const ClockAuthority = require("./ClockAuthority");
const ClockScheduler = require("./ClockScheduler");
const liveGameEnd = require("./liveGameEnd");

/**
 * Scheduler callback when absolute flag deadline wakes.
 * Always revalidates — never trusts the timer alone.
 */
async function onFlag(gameId) {
  if (!ClockScheduler.isArmed()) return;

  const live = LiveGameManager.get(gameId);
  if (!live || live.status !== "active") return;

  await live.runSerialized(async () => {
    if (live.status !== "active") return;

    const now = Date.now();
    const clockResult = ClockAuthority.drainSideToMove(live, now);

    if (!clockResult.timedOut) {
      // Move or clock change won the race — recompute absolute deadlines.
      ClockScheduler.rescheduleAll(live);
      return;
    }

    const loser = clockResult.side || ClockAuthority.activeSide(live);
    const winner = loser === "white" ? "black" : "white";

    await liveGameEnd.finalizeServerEnd(
      live,
      { winner, reason: "timeout" },
      { timedOut: true, status: "completed" }
    );
  });
}

module.exports = {
  onFlag,
};
