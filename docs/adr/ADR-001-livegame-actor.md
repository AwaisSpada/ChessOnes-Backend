# ADR-001: LiveGame Actor

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phases:** 1 (hydrate/snapshot), 2 (mutation authority)
- **Flag:** `LIVE_MEMORY_SNAPSHOT` (P1), `LIVE_HTTP_VIA_MANAGER` (P2)

## Context

Live multiplayer previously treated Mongo as the hot-path authority: each move
did `findOne` + mutate + `save` before (or racing with) socket emit. There was
no per-game mutation mutex, so concurrent HTTP posts could interleave. Clocks,
board, and turn lived across route handlers and `server.js` without a single
in-process brain.

We need Chess.com / Lichess-like latency: validate → apply → emit without
awaiting Mongo, while keeping one authoritative working state for HTTP and WS
during migration.

## Decision

Introduce a process-local **LiveGame** actor per active live-human game — a thin
analogue of a Lichess RoundActor.

LiveGame owns:

- Working board, moves, turn, clock snapshot fields
- `syncVersion` / ply
- Player ids, status / result
- Per-game mutation serialization (`runSerialized`)

Public surface includes `applyMove`, `end`, `startClocks`, `snapshot`,
`getEffectiveClocks`. LiveGame does **not** talk to Mongo directly; durability
goes through PersistenceQueue (ADR-004). Delivery goes through emit /
GameTransport (ADR-006), not raw Socket.IO forever.

**Authority rule:** if a LiveGame exists and `status === "active"`, LiveGame
wins all live reads. Mongo must never overwrite an active LiveGame on join,
sync, or GET.

**Write order:** mutate under lock → emit → enqueue persist. Never await Mongo
on the happy path before emit.

`syncVersion` bumps on every authoritative mutation (moves, flag, abandon,
first `startClocks`, HTTP `/end` mirrored into LiveGame).

Scope: live-human games only. Bot path unchanged.

## Alternatives considered

| Alternative | Outcome |
|-------------|---------|
| Keep Mongo as hot-path SoT | Rejected — latency and race surface |
| Full Lichess split (lila vs lila-ws) | Deferred / out of scope for this migration |
| Put bot / pass-play into LiveGame | Rejected — out of scope; Mongo always |
| Rehydrate / merge Mongo over active LiveGame on join | Forbidden (hydration policy H3) |
| Resurrect ended LiveGame without rematch | Rejected — new `gameId` only |
| Await Mongo before emit | Rejected — see ADR-004 |

## Consequences

- Active games consume process memory until terminal flush + evict.
- HTTP and WS must share the same LiveGame instance via LiveGameManager
  (ADR-002).
- Crash empties RAM; clients recover via hydrate from Mongo (may lag last emit).
- Ended games: flush → Manager.evict; never resurrect the same LiveGame.
- Phase 1 alone is a snapshot shell: HTTP remains Mongo writer and must
  sync/invalidate into RAM until Phase 2 owns writes.

## Trade-offs

| Benefit | Cost / risk |
|---------|-------------|
| Single mutation brain; serialized apply | Single-node / sticky until Phase 6 |
| Emit-before-persist latency | Crash can lose unflushed moves (accepted class of risk) |
| Clear read authority when LiveGame present | Ops must monitor `size()` and restart gaps |
| Shared HTTP+WS path | Dual-path bugs until flags and clients align |

## Future work

- Mirror ready-state into LiveGame if still external.
- Domain Event publishers only (ADR-007): LiveGame mutates then `publish`; no
  direct PersistenceQueue / ClockScheduler / GameTransport imports after extract.
- Premoves as server-side queue (deferred).
- Multi-instance actor ownership (Phase 6 addendum).
