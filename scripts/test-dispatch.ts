import assert from "node:assert/strict";
import { test } from "node:test";

import {
  processDueRideDispatches,
} from "../server/dispatch";

import type {
  IStorage,
  RideDispatchState,
} from "../server/storage";

import type {
  PlatformConfig,
  Ride,
  User,
  WebhookEvent,
} from "../shared/schema";

const config: PlatformConfig = {
  baseFare: 20,
  perKm: 12,
  perMinute: 0.35,
  driverSharePercent: 88,
  minimumFare: 20,
  surgePricing: false,
  surgeMultiplier: 1,
  sharedRideDiscountPercent: 15,
  groupDiscountPercent: 20,
  passengerPricingMode: "fixed",
  additionalPassengerFee: 0,
  additionalPassengerMultiplier: 1,
  dispatchInitialRadiusKm: 15,
  dispatchRadiusIncrementKm: 5,
  dispatchMaximumRadiusKm: 30,
  dispatchOfferWindowSeconds: 45,
};

const BASE_TIME = 1_000_000;

function makeRide(): Ride {
  return {
    id: "test-ride",
    riderId: "test-rider",
    status: "requested",
    rideType: "private",
    passengerCount: 1,
    pickup: { lat: 0, lng: 0, address: "Pickup" },
    dropoff: { lat: 0, lng: 0.1, address: "Dropoff" },
    createdAt: new Date(BASE_TIME).toISOString(),
  };
}

function makeDriver(
  id: string,
  distanceKm: number,
  overrides: Partial<User> = {},
): User {
  return {
    id,
    username: id,
    password: "test-password",
    role: "driver",
    fullName: id,
    phone: "00000000",
    createdAt: new Date(BASE_TIME).toISOString(),
    isOnline: true,
    suspended: false,
    currentLocation: {
      lat: 0,
      lng: distanceKm / 111.195,
    },
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2018",
      color: "White",
      plate: `TEST-${id}`,
      seatingCapacity: 4,
    },
    ...overrides,
  };
}

function createHarness(options: {
  drivers?: User[];
  ride?: Ride;
  otherRides?: Ride[];
  onOffer?: (driverId: string) => void;
  onExpire?: () => void;
} = {}) {
  let now = BASE_TIME;
  const ride = options.ride ?? makeRide();
  const drivers = options.drivers ?? [];
  const otherRides = options.otherRides ?? [];

  let dispatch: RideDispatchState | undefined;
  let locked = false;
  let acceptedDuringExpiry = false;

  const offeredDrivers = new Set<string>();
  const pendingOffers = new Map<string, number>();
  const offerCalls: string[] = [];
  const eventCalls: string[] = [];

  let activeOfferCalls = 0;
  let maximumConcurrentOfferCalls = 0;
  let finishCalls = 0;

  const storage = {
    getConfig: async () => ({ ...config }),

    getRide: async (id: string) =>
      id === ride.id ? ride : undefined,

    getOnlineDrivers: async () => [...drivers],

    getAllRides: async () => [ride, ...otherRides],

    startRideDispatch: async (rideId: string) => {
      if (rideId !== ride.id || ride.status !== "requested" || dispatch) {
        return false;
      }

      dispatch = {
        rideId,
        round: 0,
        radiusKm: 0,
        nextDispatchAt: now,
        status: "scheduled",
        updatedAt: now,
      };

      return true;
    },

    getDueRideDispatches: async (time: number, limit = 20) => {
      if (
        !dispatch ||
        dispatch.status !== "scheduled" ||
        dispatch.nextDispatchAt > time
      ) {
        return [];
      }

      return [dispatch].slice(0, limit);
    },

    getRideDispatch: async () => dispatch,

    saveRideDispatch: async (state: RideDispatchState) => {
      dispatch = { ...state };
    },

    acquireDispatchLock: async () => {
      if (locked) return false;
      locked = true;
      return true;
    },

    releaseDispatchLock: async () => {
      locked = false;
      return true;
    },

    getPendingRideOfferExpiry: async (_rideId: string, time: number) => {
      if (ride.status !== "requested") return -1;

      const expiries = [...pendingOffers.values()]
        .filter(expiry => expiry > time);

      return expiries.length ? Math.max(...expiries) : 0;
    },

    createRideOffer: async (
      driverId: string,
      rideId: string,
      windowSeconds = 45,
    ) => {
      if (
        rideId !== ride.id ||
        ride.status !== "requested" ||
        offeredDrivers.has(driverId)
      ) {
        return false;
      }

      activeOfferCalls++;
      maximumConcurrentOfferCalls = Math.max(
        maximumConcurrentOfferCalls,
        activeOfferCalls,
      );

      await Promise.resolve();

      offeredDrivers.add(driverId);
      offerCalls.push(driverId);
      pendingOffers.set(driverId, now + windowSeconds * 1000);

      activeOfferCalls--;

      options.onOffer?.(driverId);
      return true;
    },

    createEvent: async (
      event: Omit<WebhookEvent, "id" | "createdAt">,
    ): Promise<WebhookEvent> => {
      eventCalls.push(event.userId);

      return {
        ...event,
        id: `event-${eventCalls.length}`,
        createdAt: new Date(now).toISOString(),
      };
    },

    expireRideOffersForRide: async () => {
      if (ride.status !== "requested") return -1;

      options.onExpire?.();

      if (acceptedDuringExpiry) {
        ride.status = "accepted";
        return -1;
      }

      let expired = 0;

      for (const [driverId, expiry] of pendingOffers) {
        if (expiry <= now) {
          pendingOffers.delete(driverId);
          expired++;
        }
      }

      return expired;
    },

    finishRideDispatchNoDrivers: async () => {
      finishCalls++;

      if (ride.status !== "requested") return false;

      ride.status = "no_drivers_available";

      if (dispatch) {
        dispatch = {
          ...dispatch,
          status: "completed",
          updatedAt: Date.now(),
        };
      }

      return true;
    },
  };

  return {
    storage: storage as unknown as IStorage,
    ride,
    offerCalls,
    eventCalls,
    pendingOffers,
    get dispatch() { return dispatch; },
    get finishCalls() { return finishCalls; },
    get maximumConcurrentOfferCalls() {
      return maximumConcurrentOfferCalls;
    },
    setNow(value: number) { now = value; },
    setAcceptedDuringExpiry(value: boolean) {
      acceptedDuringExpiry = value;
    },
  };
}

async function withClock(
  run: (setNow: (value: number) => void) => Promise<void>,
) {
  const originalNow = Date.now;
  let now = BASE_TIME;

  Date.now = () => now;

  try {
    await run(value => {
      now = value;
    });
  } finally {
    Date.now = originalNow;
  }
}

test("broadcasts concurrently to every eligible nearby driver", async () => {
  await withClock(async () => {
    const activeRide: Ride = {
      ...makeRide(),
      id: "another-ride",
      status: "in_progress",
      driverId: "busy-driver",
    };

    const harness = createHarness({
      drivers: [
        makeDriver("near-one", 5),
        makeDriver("near-two", 12),
        makeDriver("outside", 16),
        makeDriver("offline", 4, { isOnline: false }),
        makeDriver("suspended", 4, { suspended: true }),
        makeDriver("busy-driver", 4),
        makeDriver("small-car", 4, {
          vehicleInfo: {
            make: "Small",
            model: "Car",
            year: "2020",
            color: "Blue",
            plate: "SMALL",
            seatingCapacity: 0,
          },
        }),
        makeDriver("not-driver", 4, { role: "rider" }),
      ],
      otherRides: [activeRide],
    });

    assert.equal(await harness.storage.startRideDispatch("test-ride"), true);

    await processDueRideDispatches(harness.storage);

    assert.deepEqual(
      [...harness.offerCalls].sort(),
      ["near-one", "near-two"],
    );

    assert.deepEqual(
      [...harness.eventCalls].sort(),
      ["near-one", "near-two"],
    );

    assert.equal(harness.maximumConcurrentOfferCalls, 2);
    assert.equal(harness.dispatch?.radiusKm, 15);
    assert.equal(harness.dispatch?.round, 1);
    assert.equal(
      harness.dispatch?.nextDispatchAt,
      BASE_TIME + 45_000,
    );
  });
});

test("expands through 15, 20, 25 and 30 km and waits after the final round", async () => {
  await withClock(async setNow => {
    const harness = createHarness({
      drivers: [
        makeDriver("driver-10", 10),
        makeDriver("driver-17", 17),
        makeDriver("driver-22", 22),
        makeDriver("driver-27", 27),
      ],
    });

    await harness.storage.startRideDispatch("test-ride");

    const expectedRadii = [15, 20, 25, 30];
    let roundStart = BASE_TIME;

    for (const [index, radius] of expectedRadii.entries()) {
      await processDueRideDispatches(harness.storage);

      assert.equal(harness.dispatch?.radiusKm, radius);
      assert.equal(harness.dispatch?.round, index + 1);
      assert.equal(harness.dispatch?.status, "scheduled");

      assert.equal(
        harness.dispatch?.nextDispatchAt,
        roundStart + 45_000,
      );

      if (index < expectedRadii.length - 1) {
        roundStart += 45_001;
        setNow(roundStart);
      }
    }

    assert.deepEqual(
      harness.offerCalls,
      ["driver-10", "driver-17", "driver-22", "driver-27"],
    );

    // The final 30 km round must receive its complete response window.
    assert.equal(harness.ride.status, "requested");
    assert.equal(harness.finishCalls, 0);

    setNow(roundStart + 45_001);
    await processDueRideDispatches(harness.storage);

    assert.equal(harness.ride.status, "no_drivers_available");
    assert.equal(harness.finishCalls, 1);
    assert.equal(harness.dispatch?.status, "completed");
  });
});

test("advances immediately when a round creates no offers", async () => {
  await withClock(async () => {
    const harness = createHarness({ drivers: [] });

    await harness.storage.startRideDispatch("test-ride");
    await processDueRideDispatches(harness.storage);

    assert.equal(harness.dispatch?.radiusKm, 15);
    assert.equal(harness.dispatch?.nextDispatchAt, BASE_TIME);
    assert.equal(harness.offerCalls.length, 0);
  });
});

test("recovers an interrupted round without creating duplicate offers", async () => {
  await withClock(async () => {
    const harness = createHarness({
      drivers: [makeDriver("already-offered", 5)],
    });

    await harness.storage.startRideDispatch("test-ride");

    // Simulate an offer created before a worker interruption.
    harness.offerCalls.push("already-offered");
    harness.pendingOffers.set("already-offered", BASE_TIME + 30_000);

    await harness.storage.saveRideDispatch({
      rideId: "test-ride",
      round: 1,
      radiusKm: 15,
      nextDispatchAt: BASE_TIME,
      status: "scheduled",
      updatedAt: BASE_TIME,
    });

    await processDueRideDispatches(harness.storage);

    assert.deepEqual(harness.offerCalls, ["already-offered"]);
    assert.equal(
      harness.dispatch?.nextDispatchAt,
      BASE_TIME + 30_000,
    );
    assert.equal(harness.dispatch?.radiusKm, 15);
  });
});

test("does not overwrite an acceptance during offer expiry", async () => {
  await withClock(async () => {
    const harness = createHarness();

    await harness.storage.startRideDispatch("test-ride");

    await harness.storage.saveRideDispatch({
      rideId: "test-ride",
      round: 1,
      radiusKm: 15,
      nextDispatchAt: BASE_TIME,
      status: "scheduled",
      updatedAt: BASE_TIME,
    });

    harness.setAcceptedDuringExpiry(true);

    await processDueRideDispatches(harness.storage);

    assert.equal(harness.ride.status, "accepted");
    assert.equal(harness.finishCalls, 0);
    assert.equal(harness.dispatch?.status, "completed");
  });
});

test("stops dispatch after acceptance instead of expanding again", async () => {
  await withClock(async setNow => {
    const harness = createHarness({
      drivers: [makeDriver("winner", 5)],
      onOffer: () => {
        harness.ride.status = "accepted";
      },
    });

    await harness.storage.startRideDispatch("test-ride");
    await processDueRideDispatches(harness.storage);

    assert.equal(harness.ride.status, "accepted");

    setNow(BASE_TIME + 46_000);
    await processDueRideDispatches(harness.storage);

    assert.equal(harness.ride.status, "accepted");
    assert.equal(harness.dispatch?.status, "completed");
    assert.equal(harness.finishCalls, 0);
    assert.equal(harness.offerCalls.length, 1);
  });
});
