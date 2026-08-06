# ADR-002: LiveGameManager

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 1 (+ used by all later live phases)
- **Flag:** `LIVE_MEMORY_SNAPSHOT`

## Context

Live game state was scattered: ad-hoc Maps and route-local loads in `server.js`
and HTTP handlers. Join, sync, GET, and match-found could each invent a
different “current” view of the same `gameId`. Concurrent hydrate races could
construct duplicate LiveGame instances.

We need one registry entry point for Socket, HTTP, join, sync, and create paths.

## Decision

Introduce **LiveGameManager** as the process-local registry:

- `Map<gameId, LiveGame>`
- `get`, `getOrHydrate`, `createFromDoc`, `evict`, `has` / `size`
- Per-`gameId` hydrate mutex / in-flight promise (hydration policy **H7**)

**Hydration invariants (H1–H7):**

1. Hydrate only on cache miss.
2. Seed from Mongo lean document.
3. Never merge Mongo over an existing LiveGame.
4. PersistenceQueue must not reverse-sync into LiveGame.
5. `createFromDoc` counts as hydrate (insert, don’t double-load).
6. Finished games (`completed` | `abandoned`) → Mongo only by default.
7. Concurrent `getOrHydrate` shares one in-flight promise.

**Read matrix when flag ON (active live-human):** join-game, `game:sync`,
GET `/games/:id`, reconnect → LiveGame (hydrate on miss only).

Flag OFF → Mongo always (legacy behavior). Evict after terminal + PersistenceQueue
flush success (or explicit shutdown policy).

## Alternatives considered

| Alternative | Outcome |
|-------------|---------|
| Refresh LiveGame from Mongo on every join | Rejected — rewinds if persist queue behind |
| Split brain: GET→Mongo, socket→LiveGame | Forbidden |
| “If Mongo.syncVersion > LiveGame, take Mongo” on read | Rejected for Phases 1–5 without separate reconcile design |
| Hydrate finished games by default | Rejected |
| Redis-backed registry from day one | Deferred to Phase 6 |

## Consequences

- All live entry points must go through Manager; no parallel Maps for the same
  authority.
- Crash → empty registry; recovery is hydrate-from-Mongo + client sync.
- Phase 1 requires every successful HTTP mutation to sync into LiveGame or
  evict, or RAM drifts until Phase 2 owns writes.
- Terminal eviction depends on PersistenceQueue flush (ADR-004).

## Trade-offs

| Benefit | Cost / risk |
|---------|-------------|
| One get-or-create brain | Process-local only until Phase 6 |
| Hydrate race closed by lock | Restart gap: Mongo may lag last emit |
| Clear miss-only hydrate policy | Easy to violate if a route bypasses Manager |

## Future work

- Metrics: active count, hydrate latency, miss rate.
- Phase 6 shared live store / sticky removal.
- Clear DirtyGame entry on `GAME_EVICTED` when Domain Events land (ADR-007).
