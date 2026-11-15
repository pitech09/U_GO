import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ride, User, PlatformConfig, WebhookEvent } from "../shared/schema";
import { advertiseScheduledRides, startDispatchScheduler } from "../server/dispatch";

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

const pickup = { lat: -29.3167, lng: 27.4833, address: "Pickup" };
const dropoff = { lat: -29.3, lng: 27.5, address: "Drop-off" };

function makeDriver(id: string, overrides: Partial<User> = {}): User {
  return {
    id,
    username: id,
    password: "test-password",
    role: "driver",
    fullName: id,
    phone: "00000000",
    createdAt: new Date().toISOString(),
    isOnline: true,
    suspended: false,
    currentLocation: pickup,
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2022",
      color: "White",
      plate: id,
      seatingCapacity: 4,
    },
    ...overrides,
  };
}

function makeScheduledRide(id: string, overrides: Partial<Ride> = {}): Ride {
  return {
    id,
    riderId: "rider-1",
    status: "scheduled",
    rideType: "private",
    serviceType: "ride",
    passengerCount: 1,
    pickup,
    dropoff,
    fare: {
      baseFare: 20,
      distanceFare: 10,
      timeFare: 5,
      totalFare: 35,
      driverEarnings: 30.8,
      platformFee: 4.2,
    },
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStorage(rides: Ride[], drivers: User[]) {
  const offers: Array<{ driverId: string; rideId: string }> = [];
  const events: WebhookEvent[] = [];
  const offerKeys = new Set<string>();

  const storage: any = {
    getAllRides: async () => rides,
    getOnlineDrivers: async () => drivers.filter(driver => driver.isOnline === true && !driver.suspended),
    getConfig: async () => config,
    createRideOffer: async (driverId: string, rideId: string) => {
      const key = `${driverId}:${rideId}`;
      if (offerKeys.has(key)) return false;
      offerKeys.add(key);
      offers.push({ driverId, rideId });
      return true;
    },
    createEvent: async (event: WebhookEvent) => {
      events.push(event);
      return event;
    },
    getRide: async (rideId: string) => rides.find(ride => ride.id === rideId),
    updateRide: async (rideId: string, updates: Partial<Ride>) => {
      const ride = rides.find(item => item.id === rideId);
      if (!ride) return undefined;
      Object.assign(ride, updates);
      return ride;
    },
    activateScheduledRide: async (rideId: string) => {
      const ride = rides.find(item => item.id === rideId);
      if (!ride || ride.status !== 'scheduled') return 'not_available';
      ride.status = ride.driverId ? 'accepted' : 'requested';
      return ride.driverId ? 'accepted' : 'requested';
    },
    startRideDispatch: async () => true,
    getRideDispatch: async () => undefined,
    acquireDispatchLock: async () => true,
    releaseDispatchLock: async () => true,
    getDueRideDispatches: async () => [],
  };

  return { storage, offers, events };
}

test("advertises future scheduled rides to eligible online drivers", async () => {
  const ride = makeScheduledRide("scheduled-eligible");
  const eligible = makeDriver("eligible");
  const { storage, offers, events } = makeStorage([ride], [eligible]);

  await advertiseScheduledRides(storage);

  assert.deepEqual(offers, [{ driverId: eligible.id, rideId: ride.id }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "ride_requested");
  assert.equal(events[0].userId, eligible.id);
  assert.equal(events[0].data.scheduledAt, ride.scheduledAt);
});

test("does not advertise cancelled, completed, assigned, or past scheduled rides", async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const rides = [
    makeScheduledRide("cancelled", { status: "cancelled", scheduledAt: future }),
    makeScheduledRide("completed", { status: "completed", scheduledAt: future }),
    makeScheduledRide("assigned", { driverId: "other-driver", scheduledAt: future }),
    makeScheduledRide("past", { scheduledAt: new Date(Date.now() - 1000).toISOString() }),
  ];
  const { storage, offers } = makeStorage(rides, [makeDriver("eligible")]);

  await advertiseScheduledRides(storage);

  assert.deepEqual(offers, []);
});

test("filters scheduled advertisements by capacity, radius, online status, and suspension", async () => {
  const ride = makeScheduledRide("scheduled-filtered", { passengerCount: 4 });
  const tooSmall = makeDriver("too-small", {
    vehicleInfo: { ...makeDriver("template").vehicleInfo!, seatingCapacity: 3 },
  });
  const tooFar = makeDriver("too-far", {
    currentLocation: { lat: -28.0, lng: 27.0 },
  });
  const offline = makeDriver("offline", { isOnline: false });
  const suspended = makeDriver("suspended", { suspended: true });
  const noLocation = makeDriver("no-location", { currentLocation: undefined });
  const { storage, offers } = makeStorage(
    [ride],
    [tooSmall, tooFar, offline, suspended, noLocation],
  );

  await advertiseScheduledRides(storage);

  assert.deepEqual(offers, [{ driverId: noLocation.id, rideId: ride.id }]);
});

test("does not create duplicate scheduled offers during repeated scheduler passes", async () => {
  const ride = makeScheduledRide("scheduled-duplicate");
  const driver = makeDriver("eligible");
  const { storage, offers, events } = makeStorage([ride], [driver]);

  await advertiseScheduledRides(storage);
  await advertiseScheduledRides(storage);

  assert.equal(offers.length, 1);
  assert.equal(events.length, 1);
});

test("background scheduler promotes due unassigned rides and activates assigned rides safely", async () => {
  const dueUnassigned = makeScheduledRide("due-unassigned", {
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  const dueAssigned = makeScheduledRide("due-assigned", {
    driverId: "driver-1",
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  const { storage } = makeStorage([dueUnassigned, dueAssigned], [makeDriver("driver-1")]);

  const stop = startDispatchScheduler(storage);
  await new Promise(resolve => setTimeout(resolve, 25));
  stop();

  assert.equal(dueUnassigned.status, "requested");
  assert.equal(dueAssigned.status, "accepted");
});
