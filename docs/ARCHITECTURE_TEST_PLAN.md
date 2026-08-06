# Architecture Test Plan — Live Multiplayer

**Status:** Permanent QA contract  
**Date:** 2026-08-06  
**Scope:** Live-human games only (`multiplayer` | `friend`)  
**Authority:** Derived from [docs/adr/](./adr/README.md). ADR amendments require this plan to be updated in the same change.

This document defines **what must be proven**, not how tests are implemented. No production code is specified here. Feature flags default OFF; suites must cover FLAG_ON and FLAG_OFF matrices where noted.

---

## How to use this contract

| Column / section | Meaning |
|------------------|---------|
| **Invariant** | Must always hold; a failing case is a release blocker |
| **Expected behavior** | Observable outcomes under normal conditions |
| **Integration tests** | Multi-component paths (HTTP/WS ↔ LiveGame ↔ persist ↔ clocks ↔ transport) |
| **Regression tests** | Guardrails against known historical bugs and forbidden patterns |
| **Concurrency tests** | Parallel commands, dual-path, timer + move races |
| **Failure tests** | Persist fail, emit fail, crash, stale timers, auth gaps |

### Cross-cutting rules

1. Bot / pass-play paths must remain unaffected by live flags (smoke + regression).
2. Ratings / game-completion side effects must not double-apply on idempotent end.
3. Every suite that mutates LiveGame must assert `syncVersion` monotonicity where applicable.
4. Design-only ADRs (006, 007) still have a QA contract: tests may be deferred until extract, but the cases below are the acceptance bar for that extract.

### Flag matrix (reference)

| Flag | ADR focus |
|------|-----------|
| `LIVE_MEMORY_SNAPSHOT` | ADR-001, ADR-002 |
| `LIVE_HTTP_VIA_MANAGER` | ADR-001, ADR-004 |
| `LIVE_SERVER_TIMEOUTS` | ADR-003 |
| `LIVE_WS_MOVES` | ADR-005 |
| Future `LIVE_TRANSPORT` / `LIVE_DOMAIN_EVENTS` | ADR-006, ADR-007 |

---

## ADR-001 — LiveGame Actor

### Invariant

- If LiveGame exists and `status === "active"`, LiveGame is the sole live read/write authority; Mongo must not overwrite it on join, sync, or GET.
- All mutations for a `gameId` run under per-game serialization; no interleaved board/clock/turn updates.
- Write order is mutate → emit → enqueue persist; happy path never awaits Mongo before emit.
- `syncVersion` increases on every authoritative mutation (move, flag, abandon, first `startClocks`, mirrored `/end`).
- Bot games never enter LiveGame mutation authority.
- Terminal LiveGame is flushed then evicted; it is never resurrected for a new session without a new `gameId`.

### Expected behavior

- `applyMove` / `end` / `startClocks` / `snapshot` / `getEffectiveClocks` reflect in-memory state immediately after mutate.
- Snapshot used by join/sync/GET (when flags ON) matches LiveGame, not a stale Mongo merge.
- Concurrent commands for one game are total-ordered; later commands see earlier results.
- After terminal end, subsequent commands are rejected or no-op per end policy; Manager no longer serves that actor after evict.

### Integration tests

- HTTP move (P2 ON) updates LiveGame, emits, then persists; GET/join returns LiveGame snapshot.
- WS move (P4 ON) and HTTP move share the same LiveGame instance and `syncVersion` sequence.
- Flag / abandon end path mutates LiveGame then emits ended state; hydrate miss after evict loads Mongo terminal doc only.
- Create-from-match → first move → snapshot consistency across socket and HTTP readers.
- Bot game with live flags ON still uses Mongo path; no LiveGame apply.

### Regression tests

- Abandon-after-move: move applied first under lock cannot be undone by a late abandon claim for the prior ply.
- No Mongo merge on join when LiveGame present (historical rewind bug).
- `syncVersion` bump on `startClocks` first set (not only on moves).
- Ended game rematch uses new `gameId`; old LiveGame stays dead.
- FLAG_OFF: legacy Mongo-authoritative HTTP behavior unchanged.

### Concurrency tests

- Parallel HTTP POSTs on same `gameId`: only one legal apply per turn; second gets reject/stale; board never half-applied.
- Parallel move + `/end` (resign): exactly one terminal outcome; consistent `syncVersion`.
- Parallel move + flag fire: serialization yields one winner; no double-end without idempotent claim.
- Two sockets same user racing `applyMove`: serialized; at most one apply per request rules (see ADR-005 for requestId).

### Failure tests

- Persist enqueue fails after successful apply: RAM state remains applied; no rollback of board/clocks.
- Process restart mid-game: registry empty; hydrate from Mongo (may lag last emit — assert documented gap, not silent rewind of a still-in-memory peer).
- Emit throws after mutate: LiveGame state retained; subsequent sync recovers clients.
- Illegal move / wrong seat: no mutation, no `syncVersion` bump, no persist enqueue.

---

## ADR-002 — LiveGameManager

### Invariant

- Single registry: one LiveGame per `gameId` in process.
- Hydrate only on miss (H1); seed from Mongo lean (H2); never merge Mongo over existing LiveGame (H3).
- PersistenceQueue must not reverse-sync into LiveGame (H4).
- `createFromDoc` counts as hydrate — no double construction (H5).
- Finished games (`completed` | `abandoned`) are not hydrated into an active actor by default (H6).
- Concurrent `getOrHydrate` for the same id shares one in-flight promise (H7).
- FLAG_OFF reads do not treat Manager as authority.

### Expected behavior

- First join/sync/GET (flags ON) hydrates once; subsequent reads hit the same instance.
- Match create inserts via `createFromDoc`; immediate get returns that instance without re-read race.
- After terminal flush + evict, `has(gameId)` is false; next getOrHydrate for active status only if Mongo still active (normally terminal → Mongo-only).
- `size()` reflects active actors only after proper evict.

### Integration tests

- join-game → game:sync → GET `/games/:id` all return the same `syncVersion` / ply from one LiveGame.
- Match-found create → both players join → one Manager entry.
- Terminal end → flush → evict → GET serves Mongo terminal document; no active LiveGame.
- FLAG_ON vs FLAG_OFF read matrix for join, sync, GET.

### Regression tests

- “Refresh from Mongo on every join” never reintroduced (would rewind if queue behind).
- Split brain forbidden: GET must not prefer Mongo while socket uses LiveGame when flag ON and LiveGame active.
- “If Mongo.syncVersion > LiveGame, take Mongo” on read is not implemented in Phases 1–5.
- Hydrating completed games into live actors by default remains forbidden.

### Concurrency tests

- N parallel `getOrHydrate` on cold miss: exactly one LiveGame constructed; all callers receive the same instance.
- Parallel createFromDoc vs getOrHydrate for new id: still one entry.
- Parallel evict vs get: defined outcome (miss after evict or in-flight flush policy) — no duplicate actors.

### Failure tests

- Mongo hydrate throws: no partial registry entry; retry can hydrate cleanly.
- Evict before flush completes: policy must not drop durability obligation (flush still completes or DirtyGame/ops path — assert no silent loss of terminal write intent).
- Corrupt / missing Mongo doc on miss: clear error; no empty LiveGame registered as active.

---

## ADR-003 — Server Authoritative Clocks

### Invariant

- Absolute `deadlineMs` only; no relative remaining timer chains as primary schedule.
- Only ClockAuthority computes chess time; TimeoutManager / Scheduler / Abandon must not reimplement `liveGameSync` math.
- TimeoutManager on fire always revalidates under LiveGame lock; ends only if still timed out, else reschedules.
- AbandonManager never reads chess `timeRemaining` / flag deadlines.
- ClockScheduler never ends games; only owns timer handles and `rescheduleAll`.
- FLAG_OFF: server flag/abandon schedulers disarmed; legacy client paths remain.

### Expected behavior

- After move / startClocks / hydrate / reconnect / restart: `rescheduleAll` recomputes absolute deadlines from Authority.
- Flag fire with time still remaining (stale timer): no end; new timer scheduled.
- First-move abandon windows: White ply0 / Black ply1 per product timing; reconnect cancels disconnect grace without adding clock time.
- Client timeout/abandon POST becomes soft / idempotent when FLAG_ON; server already-ended yields consistent terminal claim.

### Integration tests

- Full game: moves drain side-to-move; flag ends game; room receives ended payload; persist terminal; scheduler cancel.
- First-move abandon: no move within window → abandon end; after move → abandon timer cancelled / not applicable.
- Reconnect during grace: grace cancelled; clocks unchanged (no extra time); `rescheduleAll` restores flag deadline from stored banks.
- HTTP `/end` after server flag: idempotent; ratings/side effects once.

### Regression tests

- Abandon-after-move race (historical): move under lock beats stale abandon.
- Frozen clocks: turn flip + reschedule must update active side deadline.
- AbandonManager must not schedule from flag clock remaining.
- Monolithic TimeoutManager responsibilities must not creep back (math in Authority; timers in Scheduler; flag in Timeout; social in Abandon).
- FLAG_OFF parity with pre–Phase 3 client-driven ends.

### Concurrency tests

- Flag timer fires in the same window as a legal move: serialization — either move applies and flag revalidation no-ops, or flag ends and move rejects; never both.
- Abandon timer + first move race: same total-order guarantee.
- Parallel `rescheduleAll` vs move: no double handles leaking; at most one active flag timer per side policy.
- Two flag timers (stale + new): clearTimeout / revalidate prevents double-end.

### Failure tests

- Authority says not timed out on fire: reschedule; game stays active.
- Scheduler throws on reschedule: mutation still committed; ops/log path; Phase 6 sweeper is safety net (document expectation).
- Process restart: timers gone until hydrate + `rescheduleAll`; overdue flag detected on revalidate/sweeper path as designed.
- Client spam endGame while server flags: no double rating apply.

---

## ADR-004 — PersistenceQueue

### Invariant

- Per-`gameId` ordered async writes; emit never awaits the queue on happy path.
- Persist must not reverse-sync into LiveGame (H4).
- syncVersion fencing: older patches must not overwrite newer Mongo state.
- In-memory apply is never rolled back because persist failed.
- Evict of terminal LiveGame waits for flush success (or explicit shutdown policy).

### Expected behavior

- After move: clients see emit first; Mongo catches up in order.
- Multiple rapid moves: Mongo final state matches last LiveGame `syncVersion` / ply.
- Terminal enqueue flushes before evict; cold restart loads terminal result.
- Queue depth drains; retries are ordered per game.

### Integration tests

- Move → emit observed → Mongo eventually matches LiveGame snapshot fields.
- Burst of N moves: Mongo `syncVersion` equals LiveGame; move list length matches.
- Terminal end → flush → evict → new process hydrate/GET shows terminal doc.
- Ratings path still runs on end; queue owns document fields only (no duplicate rating from queue).

### Regression tests

- Unordered `save().catch` pattern must not return for live-human FLAG_ON path.
- Persist success must not call into LiveGame to “repair” board from Mongo.
- Await-Mongo-before-emit must not return on hot path.
- FLAG_OFF / bot: legacy save behavior not broken.

### Concurrency tests

- Parallel enqueues for same `gameId`: applied to Mongo in FIFO / version order; no torn writes.
- Parallel enqueues for different `gameId`s: independent queues; no cross-stall requirement beyond process capacity.
- Enqueue during flush of previous patch: ordering preserved; fence rejects stale.

### Failure tests

- Mongo write fails: retry/backoff; LiveGame unchanged; DirtyGame metrics when ADR-007 lands.
- Fence rejects stale patch: no downgrade of Mongo `syncVersion`.
- Crash after emit before flush: last unflushed moves may be missing on hydrate — assert this is the accepted gap (detect via syncVersion), not a silent corrupt merge.
- Flush timeout on shutdown: documented policy (block exit vs DirtyGame handoff).

---

## ADR-005 — Live Move Protocol

### Invariant

- Server is sole move authority; clients never broadcast authoritative `move-made`.
- When `LIVE_WS_MOVES` ON, unvalidated `make-move` relay is disabled.
- Seat/color from LiveGame.players — never trust client color.
- Idempotency on `(gameId, requestId)` for bounded window: at most one apply; retries replay outcome.
- `serverEventId` on every authoritative outbound live-layer event; `recoverable` on `moveRejected`.
- Client ordering: apply only if `syncVersion === last + 1` or full replace via `serverSync`; never apply out-of-order gaps.
- One in-flight `requestId` per game per client policy; retries keep the same `requestId`.

### Expected behavior

- `live:move` → `moveAccepted` (mover) + room `move-made` on success; `moveRejected` on failure.
- Duplicate `requestId`: second response matches first; board not double-applied.
- Stale `clientPly` / illegal move: reject with `recoverable` / `needSync` as specified; `live:sync` → `serverSync`.
- HTTP `POST /move` remains valid adapter when WS down or flag OFF; same MoveProcessor outcomes.
- ACK timeout guidance: `clamp(2.5 × ewmaRttMs, 1500, 8000)` documented for clients (contract test may be client-side).

### Integration tests

- Full WS happy path: move → accept + move-made → opponent sees fan-out → clocks/turn match snapshot.
- Reject path: illegal / wrong turn / stale ply → reject; LiveGame unchanged; optional serverSync.
- Idempotent retry after disconnect: same requestId returns same accept; ply advanced once.
- HTTP and WS both enabled: single apply when client uses one path; dual-send defended by lock + ply + dedupe.
- `make-move` relay ignored/disabled when FLAG_ON.

### Regression tests

- Unvalidated relay must not reappear under FLAG_ON.
- Breaking rename of `move-made` forbidden without protocol ADR change.
- New `requestId` on auto-retry must not be required (would break idempotency).
- Client color spoof rejected.
- Prefer HTTP when WS ON must not become server default policy.

### Concurrency tests

- Two `live:move` with different requestIds same turn: one accept, one reject (or ordered applies if sequential turns).
- Same requestId concurrent duplicate: one apply, identical acks.
- WS move racing HTTP move same ply: at most one apply.
- WS move racing flag/abandon: same serialization as ADR-001/003.

### Failure tests

- Auth missing / wrong user: reject; no apply.
- Ack lost (disconnect after apply before accept delivered): retry same requestId or sync recovers; no double apply.
- Emit failure after apply: state durable in RAM; serverSync on reconnect.
- Dedup window expiry: behavior documented (re-apply risk vs reject) — tests lock the chosen policy.

---

## ADR-006 — GameTransport

### Invariant

- After extract: LiveGame / move pipeline / Timeout / Abandon never call Socket.IO directly.
- Transport does not own legality, clocks, flag/abandon, Mongo, auth, or mutation authority.
- Delivery ≠ authority: swapping transport must not change LiveGame outcomes.
- Public method set is the sole emit surface: moveMade, moveAccepted, moveRejected, serverSync, gameEnded, connectionStatus.
- Addressing prefers `userId` for post-reconnect ack; room fan-out by `gameId`.

### Expected behavior

- SocketIOTransport is behavior-identical to pre-extract emits for the same domain outcomes.
- TestingTransport records ordered calls for assertions without a real socket server.
- Future RedisTransport fans out the same logical events; LiveGame still process-local until Phase 6 store.

### Integration tests

- (Post-extract) Move / flag / abandon / reconnect paths emit only via GameTransport methods.
- SocketIOTransport end-to-end: clients receive same event names/payloads as Phase 4 protocol.
- TestingTransport: MOVE apply produces expected emit sequence (accept + move-made, then persist side effects remain outside transport).
- Boot `createGameTransport(env)` selects impl without LiveGame code changes.

### Regression tests

- No new `io.to(...).emit` in live mutation modules after extract (static/architecture check).
- Transport must not grow `applyMove` / clock math / `game.save`.
- Wire event → method mapping remains stable (`move-made` → `emitMoveMade`, etc.).

### Concurrency tests

- Parallel emits for different games: no cross-talk of rooms / user targets.
- Parallel emitMoveAccepted to userId after reconnect: delivered to current socket mapping (presence integration).
- Ordered emits for one game: move-made before game-ended on terminal move; TestingTransport asserts order.

### Failure tests

- Transport emit throws: mutation and persist path continue (non-fatal); client recovers via sync.
- Unknown userId / disconnected socket on ack: room fan-out still occurs; ack best-effort; sync recovers.
- Misconfigured RedisTransport (when enabled): fail closed to ops visibility; must not corrupt LiveGame.

**Note:** Until extract lands, mark these cases as **pending acceptance** for the GameTransport PR; do not weaken the contract.

---

## ADR-007 — Domain Events

### Invariant

- Internal Domain Events and Public Transport Events are different concepts/schemas.
- Flow: Domain Events → Projection → GameTransport (never raw LiveGame to sockets).
- Envelope includes `origin` ∈ { HTTP, WS, Timeout, Abandon, Reconnect, Recovery, System }.
- Subscribers never mutate board, clocks, turns, status, or `syncVersion`.
- Subscriber order for moves: Projection → Persistence (+ DirtyGame) → Scheduler → optional others.
- Persist failure marks DirtyGame + metrics + retry + alert after threshold; no LiveGame rollback.
- Bus is synchronous sequential per publish in registration order (single process).

### Expected behavior

- After mutate, published `MOVE_APPLIED` (etc.) carries correct `syncVersion`, `gameId`, `origin`.
- Projection emits public DTOs only; internal fields do not leak on the wire.
- DirtyGame clears on successful persist; alerts fire only after configured threshold.
- Failure in Projection does not skip Persistence/Scheduler registration order policy (continue after log).

### Integration tests

- (Post-implement) Move path: publish → projection emit → persist enqueue → reschedule; no direct io/persist/schedule in LiveGame.
- Timeout / Abandon publishes with `origin` Timeout / Abandon; projections match protocol events.
- Reconnect publishes with `origin` Reconnect; connection status + serverSync via projection.
- Extensibility smoke: analytics subscriber can observe without affecting board.

### Regression tests

- Subscriber mutating LiveGame is forbidden (architecture test / lint / runtime guard in test doubles).
- Persistence before Projection order must not ship.
- Shared schema for domain + wire must not ship.
- Kafka/outbox not required for v1 acceptance.
- FLAG / dual-write phases (M1–M5): dual-write must not double-emit to clients.

### Concurrency tests

- Parallel publishes for different games: isolated handlers; no shared mutable LiveGame cross-talk.
- Single game serialized mutations: event `syncVersion` sequence matches apply order.
- Slow Projection handler: still ordered before Persistence for that publish (latency trade-off accepted).

### Failure tests

- Projection throws: logged; Persistence + Scheduler still run; LiveGame unchanged by subscribers.
- Persist fails: DirtyGame set; metrics incremented; retry; alert after N/T; board unchanged.
- Scheduler throws: logged; mutation remains; sweeper safety net documented.
- Handler throws mid-list: bus continues remaining subscribers (v1 isolate policy).

**Note:** Frozen design — cases are the QA bar for the Domain Events implementation phase; dual-write windows need explicit double-emit guards.

---

## Cross-ADR scenario suites

These scenarios prove multiple ADRs together. Treat as release gates when the involved flags are ON.

| Suite | ADRs | Must prove |
|-------|------|------------|
| Hot move path | 001, 004, 005, 006/007 | mutate → emit → persist order; syncVersion; idempotent requestId |
| Flag vs move race | 001, 003, 005 | one terminal or one move; clocks consistent |
| Abandon vs move race | 001, 003 | abandon-after-move impossible |
| Reconnect mid-game | 002, 003, 005, 006 | hydrate miss-only; rescheduleAll; no clock gift; serverSync |
| Crash recovery | 001, 002, 004 | empty registry; Mongo hydrate; accepted persist lag |
| Terminal once | 001, 003, 004 | one result; one rating apply; flush then evict |
| Dual HTTP+WS | 001, 005 | at most one apply per ply |
| Transport swap | 006 | TestingTransport vs SocketIO identical ordering |
| Dirty persist | 004, 007 | DirtyGame; no rollback; alert threshold |

---

## FLAG_OFF / compatibility contract

For every ADR-backed feature flag:

1. FLAG_OFF restores pre-feature observable behavior for live-human games (documented legacy).
2. Enabling a flag must not require other flags beyond the ADR hard deps (e.g. WS requires Phase 2).
3. Bot / pass-play suites remain green with all live flags ON and OFF.

---

## Evidence and sign-off

| Gate | Requirement |
|------|-------------|
| Phase enablement | Integration + concurrency + failure suites for that ADR’s flag are green in CI or recorded manual evidence |
| Extract PR (006/007) | Pending cases above become mandatory; architecture regression checks land in the same PR |
| Production flag ON | Cross-ADR scenario suites for involved flags signed off; rollback = FLAG_OFF verified |

Failures against **Invariant** rows are release blockers. Failures against **Expected behavior** under normal paths are release blockers. Known accepted gaps (emit-before-persist crash lag) must be asserted as documented behavior, not ignored.

---

## Document control

- **Owner:** Live multiplayer architecture
- **Change rule:** Update this plan in the same change as any ADR revision
- **Non-goals:** Test runner choice, file layout, assertion libraries, CI YAML — those are implementation details outside this contract
