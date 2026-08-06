/**
 * ADR-007 synchronous in-process EventBus.
 * Handlers awaited sequentially in registration order. Failures are isolated.
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Array<(event: object) => unknown>>} */
    this._handlers = new Map();
  }

  /**
   * @param {string} eventType
   * @param {(event: object) => unknown} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(eventType, handler) {
    if (!eventType || typeof handler !== "function") {
      throw new Error("subscribe(eventType, handler) required");
    }
    const list = this._handlers.get(eventType) || [];
    list.push(handler);
    this._handlers.set(eventType, list);
    return () => this.unsubscribe(eventType, handler);
  }

  unsubscribe(eventType, handler) {
    const list = this._handlers.get(eventType);
    if (!list) return;
    const next = list.filter((h) => h !== handler);
    if (next.length) this._handlers.set(eventType, next);
    else this._handlers.delete(eventType);
  }

  /**
   * Synchronously invoke handlers in order; await each (including async).
   * @param {object} event
   */
  async publish(event) {
    if (!event?.eventType) return;
    const list = this._handlers.get(event.eventType) || [];
    for (const handler of list) {
      try {
        await handler(event);
      } catch (err) {
        console.error(
          `[EventBus] handler failed type=${event.eventType} eventId=${event.eventId}:`,
          err?.message || err
        );
      }
    }
  }

  clear() {
    this._handlers.clear();
  }

  handlerCount(eventType) {
    return (this._handlers.get(eventType) || []).length;
  }
}

/** Process-local singleton */
const bus = new EventBus();

module.exports = {
  EventBus,
  bus,
  publish: (event) => bus.publish(event),
  subscribe: (eventType, handler) => bus.subscribe(eventType, handler),
  unsubscribe: (eventType, handler) => bus.unsubscribe(eventType, handler),
};
