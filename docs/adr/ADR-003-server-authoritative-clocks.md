# ADR-003: Server Authoritative Clocks

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 3 (bindings locked; supersedes monolithic TimeoutManager shape)
- **Flag:** `LIVE_SERVER_TIMEOUTS` (requires `LIVE_MEMORY_SNAPSHOT`)

## Context

Client-authoritative timeout and abandon produced races: abandon after a move
had already registered; missing auto-flag; frozen or drifting clocks. A single
TimeoutManager concept mixed chess-time math, `setTimeout` handles, flag
outcomes, and social disconnect / first-move abandon rules — hard to test and
easy to conflate.

Primary detection must be server-side absolute deadlines, not floating
“remaining ms” timer chains.

## Decision

Server is authoritative for **flag** and **first-move abandon**. Client
timeout/abandon become display-only / soft / idempotent `POST /end`.

Locked component split:

| Component | Owns | Must not |
|-----------|------|----------|
| **ClockManager** (P0) | Pure formulas over `liveGameSync` + increment | Timers, ends |
| **ClockAuthority** | Sole chess-time math (remaining, drain, side, increment, `msUntilFlag`) | `setTimeout`, ending games |
| **ClockScheduler** | Timer handles; schedules from **absolute `deadlineMs` only**; `rescheduleAll(live)` | Ending games; inventing math |
| **TimeoutManager** | Flag execution: on fire, revalidate under lock via Authority; end only if still timed out | Abandon / disconnect grace |
| **AbandonManager** | First-move abandon windows; disconnect grace; reconnect cancel | Chess clocks / `timeRemaining` / flag deadlines |

**Invariants:**

1. Absolute deadlines only: `deadlineMs = serverNow + effectiveRemaining` (or
   abandon anchors); every reschedule recomputes.
2. Only ClockAuthority computes live chess time; no re-implementing
   `liveGameSync` elsewhere.
3. TimeoutManager revalidates on every fire under the LiveGame mutation lock.
4. AbandonManager never owns chess clocks.
5. `ClockScheduler.rescheduleAll` after move, `startClocks`, hydrate, reconnect,
   restart.

Flag OFF → Scheduler disarmed; legacy client abandon / move-path timeout remain.

## Alternatives considered

| Alternative | Outcome |
|-------------|---------|
| Monolithic TimeoutManager for math + timers + flag + abandon | Rejected — split locked |
| Relative remaining timer chains | Forbidden |
| Abandon using flag clock (or vice versa) | Forbidden |
| Coarse periodic sweeper as primary detection | Deferred — Phase 6 safety net only |
| Redis / multi-instance timer ownership | Deferred — Phase 6 |
| Lag compensation v1 | Deferred |

## Consequences

- Flag and abandon share LiveGame serialization with moves (ADR-001).
- Double-end races with client `POST /end` require idempotent terminal claim.
- Process restart: hydrate then `rescheduleAll` or timers are gone.
- Frontend may see 409 / noise if it still fires endGame while server already
  ended.
- Roadmap text that still says “TimeoutManager” for create path is superseded
  by this split for implementation shape.

## Trade-offs

| Benefit | Cost / risk |
|---------|-------------|
| Testable Authority without faking timers | More modules / wiring |
| No drift from relative chains | Must reschedule after every relevant mutation |
| Clear flag vs abandon boundary | Wrong abandon window if turn anchors wrong |
| Server-owned flag | FE must stop treating client timeout as authority |

## Future work

- Phase 6 coarse sweeper (docs requirement, not primary).
- Disconnect grace product timing: harden in Phase 5 (`LIVE_RECONNECT_V2`
  optional); boundary already fixed here.
- Reconnect: ReconnectManager + `rescheduleAll` +
  `AbandonManager.cancelDisconnectGrace` on rejoin.
- Multi-instance timer ownership (Phase 6).
