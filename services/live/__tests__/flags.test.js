/**
 * Flag matrix smoke — modules load; flags parse; transport boots without io in testing mode.
 */

describe("Live feature flags", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetModules();
  });

  test("defaults are OFF", () => {
    delete process.env.LIVE_MEMORY_SNAPSHOT;
    delete process.env.LIVE_HTTP_VIA_MANAGER;
    delete process.env.LIVE_SERVER_TIMEOUTS;
    delete process.env.LIVE_WS_MOVES;
    delete process.env.LIVE_DOMAIN_EVENTS;
    const flags = require("../flags");
    expect(flags.LIVE_MEMORY_SNAPSHOT).toBe(false);
    expect(flags.LIVE_HTTP_VIA_MANAGER).toBe(false);
    expect(flags.LIVE_SERVER_TIMEOUTS).toBe(false);
    expect(flags.LIVE_WS_MOVES).toBe(false);
    expect(flags.LIVE_DOMAIN_EVENTS).toBe(false);
    expect(flags.LIVE_TRANSPORT).toBe("socket");
  });

  test("LIVE_DOMAIN_EVENTS can enable", () => {
    process.env.LIVE_DOMAIN_EVENTS = "true";
    const flags = require("../flags");
    expect(flags.LIVE_DOMAIN_EVENTS).toBe(true);
  });
});
