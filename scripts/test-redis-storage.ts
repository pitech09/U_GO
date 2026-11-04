import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { calculateDistance } from "../shared/distance";

import type { User, Ride } from "../shared/schema";

const redisUrl = process.env.REDIS_TEST_URL;

if (!redisUrl) {
  throw new Error("REDIS_TEST_URL must point to a dedicated test Redis instance.");
}

let storage: any;
let redisClient: any;
let savedRide: Ride;

const riderInput: Omit<User, "id" | "createdAt"> = {
  username: "redis-integration-rider",
  password: "test-password",
  role: "rider",
  fullName: "Redis Integration Rider",
  phone: "0000000000",
};

before(async () => {
  // Set this before importing storage.ts.
  process.env.REDIS_URL = redisUrl;
  Reflect.set(process.env, "NODE_ENV", "test");

  const { RedisStorage } = await import("../server/storage");

  storage = new RedisStorage();

  // This connects only to the isolated Redis server on port 6389.
  await storage.initialize();

  redisClient = (storage as unknown as { redis: any }).redis;
});

after(async () => {
  if (redisClient) {
    await redisClient.quit();
  }
});

test("RedisStorage saves and retrieves a Shared ride with its complete fare", async () => {
  // Verify the initial default configuration.
  const defaults = await storage.getConfig();
  assert.equal(defaults.sharedRideDiscountPercent, 15);

  // Configure a passenger fee to verify persistence of the surcharge.
  const config = await storage.updateConfig({
    sharedRideDiscountPercent: 15,
    passengerPricingMode: "fixed",
    additionalPassengerFee: 5,
  });

  assert.equal(config.sharedRideDiscountPercent, 15);
  assert.equal(config.additionalPassengerFee, 5);

  const rider = await storage.createUser(riderInput);

  const rideInput = {
    riderId: rider.id,
    status: "requested" as const,
    rideType: "shared" as const,
    additionalPassengers: 2,
    pickup: {
      lat: -29.3167,
      lng: 27.4833,
      address: "Test pickup",
    },
    dropoff: {
      lat: -29.3,
      lng: 27.5,
      address: "Test dropoff",
    },
    riderName: rider.fullName,
  };

  // Use the exact coordinates that will be used by createRide().
  const distanceKm = calculateDistance(
    rideInput.pickup.lat,
    rideInput.pickup.lng,
    rideInput.dropoff.lat,
    rideInput.dropoff.lng
  );

  // Calculate the estimate through the real storage implementation.
  const estimate = await storage.calculateFareForDistance(
    distanceKm,
    2,
    "shared"
  );

  assert.equal(estimate.sharedRideDiscountPercent, 15);
  assert.equal(estimate.passengerFare, 10);

  // Create the booking through the actual RedisStorage implementation.
  savedRide = await storage.createRide(rideInput);

  assert.ok(savedRide.id);
  assert.equal(savedRide.rideType, "shared");
  assert.equal(savedRide.additionalPassengers, 2);
  assert.equal(savedRide.passengerCount, 3);
  assert.equal(savedRide.status, "requested");

  assert.ok(savedRide.fare);
  assert.equal(savedRide.fare?.sharedRideDiscountPercent, 15);
  assert.equal(savedRide.fare?.passengerFare, 10);
  assert.ok((savedRide.fare?.sharedDiscount ?? 0) > 0);

  // The estimate and actual booking must produce identical fares.
  assert.equal(savedRide.fare?.totalFare, estimate.totalFare);
  assert.equal(savedRide.fare?.sharedDiscount, estimate.sharedDiscount);
  assert.equal(savedRide.fare?.passengerFare, estimate.passengerFare);
  assert.equal(savedRide.fare?.driverEarnings, estimate.driverEarnings);
  assert.equal(savedRide.fare?.platformFee, estimate.platformFee);

  // Retrieve the actual saved JSON record from Redis.
  const retrieved = await storage.getRide(savedRide.id);

  assert.ok(retrieved);
  assert.equal(retrieved.id, savedRide.id);
  assert.equal(retrieved.riderId, rider.id);
  assert.equal(retrieved.rideType, "shared");
  assert.equal(retrieved.additionalPassengers, 2);
  assert.equal(retrieved.passengerCount, 3);

  assert.deepEqual(retrieved.fare, savedRide.fare);

  // Verify the booking is also discoverable through rider history.
  const riderRides = await storage.getRidesByRider(rider.id);

  assert.ok(riderRides.some((ride: Ride) => ride.id === savedRide.id));

  // Confirm configuration survived a fresh read from Redis.
  const persistedConfig = await storage.getConfig();

  assert.equal(persistedConfig.sharedRideDiscountPercent, 15);
  assert.equal(persistedConfig.additionalPassengerFee, 5);

  console.log("Shared ride ID:", savedRide.id);
  console.log("Stored passenger count:", retrieved.passengerCount);
  console.log("Stored passenger surcharge:", retrieved.fare?.passengerFare);
  console.log("Stored Shared discount:", retrieved.fare?.sharedDiscount);
  console.log("Stored total fare:", retrieved.fare?.totalFare);
  console.log("Stored driver earnings:", retrieved.fare?.driverEarnings);
  console.log("Stored platform fee:", retrieved.fare?.platformFee);
});


async function createAcceptanceFixture(options: {
  role?: "rider" | "driver";
  capacity?: number;
  includeVehicle?: boolean;
  isOnline?: boolean;
  suspended?: boolean;
  additionalPassengers?: number;
} = {}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

  const driverInput: any = {
    username: `acceptance-driver-${suffix}`,
    password: "test-password",
    role: options.role ?? "driver",
    fullName: "Acceptance Test Driver",
    phone: "0000000000",
    isOnline: options.isOnline ?? true,
    suspended: options.suspended ?? false,
  };

  if (options.includeVehicle !== false) {
    driverInput.vehicleInfo = {
      make: "Toyota",
      model: "Vitz",
      year: "2022",
      color: "White",
      plate: `TEST-${suffix}`,
      seatingCapacity: options.capacity,
    };
  }

  const driver = await storage.createUser(driverInput);

  const rider = await storage.createUser({
    username: `acceptance-rider-${suffix}`,
    password: "test-password",
    role: "rider",
    fullName: "Acceptance Test Rider",
    phone: "0000000000",
  });

  const ride = await storage.createRide({
    riderId: rider.id,
    status: "requested",
    rideType: "private",
    additionalPassengers: options.additionalPassengers ?? 0,
    pickup: {
      lat: -29.3167,
      lng: 27.4833,
      address: "Test pickup",
    },
    dropoff: {
      lat: -29.3,
      lng: 27.5,
      address: "Test dropoff",
    },
    riderName: rider.fullName,
  });

  assert.equal(
    await storage.createRideOffer(driver.id, ride.id),
    true,
    "Test ride offer should be created"
  );

  return { driver, ride };
}

async function assertRejectedAcceptance(
  options: Parameters<typeof createAcceptanceFixture>[0],
  expectedStatus: string
) {
  const { driver, ride } = await createAcceptanceFixture(options);
  const result = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(result.status, expectedStatus);

  const savedRide = await storage.getRide(ride.id);
  assert.equal(savedRide.status, "requested");
  assert.equal(savedRide.driverId, undefined);
}

test("Redis atomically accepts a booking at the exact vehicle capacity", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
    additionalPassengers: 3,
  });

  assert.equal(ride.passengerCount, 4);

  const result = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(result.status, "accepted");
  assert.equal(result.ride?.driverId, driver.id);
  assert.equal(result.ride?.status, "accepted");
});

test("Redis rejects a booking that exceeds vehicle capacity", async () => {
  await assertRejectedAcceptance({
    capacity: 2,
    additionalPassengers: 2,
  }, "capacity_exceeded");
});

test("Redis rejects drivers with unverified seating capacity", async () => {
  await assertRejectedAcceptance({
    includeVehicle: false,
  }, "capacity_unverified");
});

test("Redis rejects drivers whose vehicle capacity is missing", async () => {
  await assertRejectedAcceptance({
    capacity: undefined,
  }, "capacity_unverified");
});

test("Redis rejects fractional vehicle seating capacity", async () => {
  await assertRejectedAcceptance({
    capacity: 2.5,
  }, "capacity_unverified");
});

test("Redis rejects offline drivers", async () => {
  await assertRejectedAcceptance({
    capacity: 4,
    isOnline: false,
  }, "driver_offline");
});

test("Redis rejects suspended drivers", async () => {
  await assertRejectedAcceptance({
    capacity: 4,
    suspended: true,
  }, "driver_suspended");
});

test("Redis rejects accounts that are not drivers", async () => {
  await assertRejectedAcceptance({
    role: "rider",
    capacity: 4,
  }, "not_driver");
});


test("Redis rejects duplicate offers for the same driver and ride", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
  });

  assert.equal(
    await storage.createRideOffer(driver.id, ride.id),
    false
  );

  const queueCount = await redisClient.zcard(
    `rideflow:driver_offers:${driver.id}`
  );

  assert.equal(queueCount, 1);
});

test("Redis refuses expired offers and marks them expired during retrieval", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
  });

  const offerKey = `${driver.id}:${ride.id}`;
  const stored = await redisClient.hget("rideflow:offers", offerKey);
  assert.ok(stored);

  const offer = JSON.parse(stored);
  offer.expiresAt = Date.now() - 1000;

  await redisClient.hset(
    "rideflow:offers",
    offerKey,
    JSON.stringify(offer)
  );
  await redisClient.zadd(
    `rideflow:driver_offers:${driver.id}`,
    offer.expiresAt,
    ride.id
  );

  const acceptance = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(acceptance.status, "offer_missing");

  const savedRide = await storage.getRide(ride.id);
  assert.equal(savedRide.status, "requested");

  const visibleOffers = await storage.getDriverRideOffers(driver.id);
  assert.equal(
    visibleOffers.some((item: Ride) => item.id === ride.id),
    false
  );

  const expiredData = await redisClient.hget("rideflow:offers", offerKey);
  assert.equal(JSON.parse(expiredData).status, "expired");

  // Verify the offered-driver set independently prevents another dispatch round.
  await redisClient.del(`rideflow:driver_rejections:${driver.id}`);

  assert.equal(
    await storage.createRideOffer(driver.id, ride.id),
    false,
    "An expired offer must not be sent to the same driver again"
  );

  assert.equal(
    await redisClient.zcard(`rideflow:driver_offers:${driver.id}`),
    0
  );
});

test("Redis expires every pending offer before dispatch expansion", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
  });

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

  const secondDriver = await storage.createUser({
    username: `expiry-driver-${suffix}`,
    password: "test-password",
    role: "driver",
    fullName: "Second Expiry Driver",
    phone: "0000000002",
    isOnline: true,
    suspended: false,
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2022",
      color: "White",
      plate: `EXP-${suffix}`,
      seatingCapacity: 4,
    },
  });

  assert.equal(await storage.createRideOffer(secondDriver.id, ride.id), true);

  const expiredCount = await storage.expireRideOffersForRide(ride.id);
  assert.equal(expiredCount, 2);

  for (const candidate of [driver, secondDriver]) {
    const offer = await redisClient.hget(
      "rideflow:offers",
      `${candidate.id}:${ride.id}`
    );

    assert.equal(JSON.parse(offer).status, "expired");
    assert.equal(
      await redisClient.zcard(`rideflow:driver_offers:${candidate.id}`),
      0
    );

    assert.equal(
      await redisClient.sismember(
        `rideflow:ride_offered_drivers:${ride.id}`,
        candidate.id
      ),
      1
    );

    assert.equal(
      await storage.createRideOffer(candidate.id, ride.id),
      false,
      "Previously contacted drivers must not receive the same ride again"
    );
  }

  assert.equal(await storage.expireRideOffersForRide(ride.id), 0);
});

test("Redis does not expire offers after a ride has been accepted", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
  });

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

  const secondDriver = await storage.createUser({
    username: `accepted-expiry-driver-${suffix}`,
    password: "test-password",
    role: "driver",
    fullName: "Second Accepted Expiry Driver",
    phone: "0000000003",
    isOnline: true,
    suspended: false,
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2022",
      color: "White",
      plate: `ACC-${suffix}`,
      seatingCapacity: 4,
    },
  });

  assert.equal(await storage.createRideOffer(secondDriver.id, ride.id), true);

  const accepted = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(accepted.status, "accepted");
  assert.equal(await storage.expireRideOffersForRide(ride.id), -1);

  for (const candidate of [driver, secondDriver]) {
    const offer = await redisClient.hget(
      "rideflow:offers",
      `${candidate.id}:${ride.id}`
    );

    assert.equal(JSON.parse(offer).status, "withdrawn");
    assert.equal(
      await redisClient.zcard(`rideflow:driver_offers:${candidate.id}`),
      0
    );
  }
});

test("Redis withdraws competing offers when a ride is accepted", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
  });

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

  const otherDriver = await storage.createUser({
    username: `competing-driver-${suffix}`,
    password: "test-password",
    role: "driver",
    fullName: "Competing Test Driver",
    phone: "0000000000",
    isOnline: true,
    suspended: false,
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2022",
      color: "White",
      plate: `OTHER-${suffix}`,
      seatingCapacity: 4,
    },
  });

  assert.equal(
    await storage.createRideOffer(otherDriver.id, ride.id),
    true
  );

  const secondRide = await storage.createRide({
    riderId: ride.riderId,
    status: "requested",
    rideType: "private",
    additionalPassengers: 0,
    pickup: ride.pickup,
    dropoff: ride.dropoff,
    riderName: ride.riderName,
  });

  assert.equal(
    await storage.createRideOffer(driver.id, secondRide.id),
    true
  );

  const result = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(result.status, "accepted");

  const winningDriverOtherOffer = await redisClient.hget(
    "rideflow:offers",
    `${driver.id}:${secondRide.id}`
  );

  const competingDriverOffer = await redisClient.hget(
    "rideflow:offers",
    `${otherDriver.id}:${ride.id}`
  );

  assert.equal(JSON.parse(winningDriverOtherOffer).status, "withdrawn");
  assert.equal(JSON.parse(competingDriverOffer).status, "withdrawn");

  assert.equal(
    await redisClient.zcard(`rideflow:driver_offers:${driver.id}`),
    0
  );
  assert.equal(
    await redisClient.zcard(`rideflow:driver_offers:${otherDriver.id}`),
    0
  );
});


test("Redis allows only one driver to win simultaneous acceptance", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
  });

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

  const secondDriver = await storage.createUser({
    username: `race-driver-${suffix}`,
    password: "test-password",
    role: "driver",
    fullName: "Race Test Driver",
    phone: "0000000000",
    isOnline: true,
    suspended: false,
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2022",
      color: "White",
      plate: `RACE-${suffix}`,
      seatingCapacity: 4,
    },
  });

  assert.equal(
    await storage.createRideOffer(secondDriver.id, ride.id),
    true
  );

  const results = await Promise.all([
    storage.acceptRideOffer(driver.id, ride.id, driver.fullName),
    storage.acceptRideOffer(secondDriver.id, ride.id, secondDriver.fullName),
  ]);

  const accepted = results.filter(result => result.status === "accepted");
  assert.equal(accepted.length, 1);

  const savedRide = await storage.getRide(ride.id);
  assert.equal(savedRide.status, "accepted");

  const winnerId = accepted[0].ride?.driverId;
  assert.ok(winnerId === driver.id || winnerId === secondDriver.id);
  assert.equal(savedRide.driverId, winnerId);

  const loserId = winnerId === driver.id ? secondDriver.id : driver.id;
  const losingOffer = await redisClient.hget(
    "rideflow:offers",
    `${loserId}:${ride.id}`
  );

  assert.equal(JSON.parse(losingOffer).status, "withdrawn");
});

test("Redis prevents a driver from accepting a second active ride", async () => {
  const { driver, ride } = await createAcceptanceFixture({
    capacity: 4,
  });

  const first = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(first.status, "accepted");

  const secondRide = await storage.createRide({
    riderId: ride.riderId,
    status: "requested",
    rideType: "private",
    additionalPassengers: 0,
    pickup: ride.pickup,
    dropoff: ride.dropoff,
    riderName: ride.riderName,
  });

  assert.equal(
    await storage.createRideOffer(driver.id, secondRide.id),
    true
  );

  const second = await storage.acceptRideOffer(
    driver.id,
    secondRide.id,
    driver.fullName
  );

  assert.equal(second.status, "active_ride");

  const savedSecondRide = await storage.getRide(secondRide.id);
  assert.equal(savedSecondRide.status, "requested");
  assert.equal(savedSecondRide.driverId, undefined);
});


test("Redis recovers the latest unexpired pending offer deadline", async () => {
  const { driver, ride } = await createAcceptanceFixture({ capacity: 4 });

  assert.equal(await storage.startRideDispatch(ride.id), true);

  // The fixture already created a pending 45-second offer.
  const expiry = await storage.getPendingRideOfferExpiry(
    ride.id,
    Date.now()
  );

  assert.ok(expiry > Date.now());
  assert.ok(expiry <= Date.now() + 46000);

  const accepted = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(accepted.status, "accepted");
  assert.equal(
    await storage.getPendingRideOfferExpiry(ride.id, Date.now()),
    -1
  );
});

test("Redis creates dispatch state only once for a requested ride", async () => {
  const { ride } = await createAcceptanceFixture({ capacity: 4 });

  assert.equal(await storage.startRideDispatch(ride.id), true);
  assert.equal(await storage.startRideDispatch(ride.id), false);

  const state = await storage.getRideDispatch(ride.id);

  assert.ok(state);
  assert.equal(state.rideId, ride.id);
  assert.equal(state.round, 0);
  assert.equal(state.radiusKm, 0);
  assert.equal(state.status, "scheduled");

  const due = await storage.getDueRideDispatches(Date.now(), 100);
  assert.ok(due.some((item: any) => item.rideId === ride.id));
});

test("Redis does not start dispatch for an accepted ride", async () => {
  const { driver, ride } = await createAcceptanceFixture({ capacity: 4 });

  const accepted = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(accepted.status, "accepted");
  assert.equal(await storage.startRideDispatch(ride.id), false);
  assert.equal(await storage.getRideDispatch(ride.id), undefined);
});

test("Redis updates dispatch deadlines and removes completed dispatches from the due queue", async () => {
  const { ride } = await createAcceptanceFixture({ capacity: 4 });

  assert.equal(await storage.startRideDispatch(ride.id), true);

  const future = Date.now() + 60000;

  const updated = {
    rideId: ride.id,
    round: 2,
    radiusKm: 20,
    nextDispatchAt: future,
    status: "scheduled" as const,
    updatedAt: Date.now(),
  };

  await storage.saveRideDispatch(updated);

  assert.equal(await storage.getRideDispatch(ride.id).then((v: any) => v.round), 2);

  const dueBefore = await storage.getDueRideDispatches(Date.now());
  assert.equal(dueBefore.some((item: any) => item.rideId === ride.id), false);

  await storage.saveRideDispatch({
    ...updated,
    status: "completed",
    updatedAt: Date.now(),
  });

  assert.equal(
    await redisClient.zscore("rideflow:dispatch_due", ride.id),
    null
  );

  const completed = await storage.getRideDispatch(ride.id);
  assert.equal(completed.status, "completed");
});

test("Redis dispatch lock prevents competing workers and validates release tokens", async () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const firstToken = `worker-a-${suffix}`;
  const secondToken = `worker-b-${suffix}`;

  assert.equal(await storage.acquireDispatchLock(firstToken, 10000), true);
  assert.equal(await storage.acquireDispatchLock(secondToken, 10000), false);

  assert.equal(await storage.releaseDispatchLock(secondToken), false);
  assert.equal(await storage.acquireDispatchLock(secondToken, 10000), false);

  assert.equal(await storage.releaseDispatchLock(firstToken), true);
  assert.equal(await storage.acquireDispatchLock(secondToken, 10000), true);
  assert.equal(await storage.releaseDispatchLock(secondToken), true);
});

test("Redis dispatch lock expires and can be acquired by another worker", async () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const firstToken = `expiring-worker-${suffix}`;
  const secondToken = `replacement-worker-${suffix}`;

  assert.equal(await storage.acquireDispatchLock(firstToken, 100), true);

  await new Promise(resolve => setTimeout(resolve, 180));

  assert.equal(await storage.acquireDispatchLock(secondToken, 10000), true);
  assert.equal(await storage.releaseDispatchLock(firstToken), false);
  assert.equal(await storage.releaseDispatchLock(secondToken), true);
});

test("Redis atomically marks an unaccepted ride unavailable and completes dispatch", async () => {
  const { ride } = await createAcceptanceFixture({ capacity: 4 });

  assert.equal(await storage.startRideDispatch(ride.id), true);

  assert.equal(
    await storage.finishRideDispatchNoDrivers(ride.id),
    true
  );

  const savedRide = await storage.getRide(ride.id);
  assert.equal(savedRide.status, "no_drivers_available");

  const dispatch = await storage.getRideDispatch(ride.id);
  assert.ok(dispatch);
  assert.equal(dispatch.status, "completed");

  assert.equal(
    await redisClient.zscore("rideflow:dispatch_due", ride.id),
    null
  );
});

test("Redis terminal dispatch transition cannot overwrite an accepted ride", async () => {
  const { driver, ride } = await createAcceptanceFixture({ capacity: 4 });

  assert.equal(await storage.startRideDispatch(ride.id), true);

  const accepted = await storage.acceptRideOffer(
    driver.id,
    ride.id,
    driver.fullName
  );

  assert.equal(accepted.status, "accepted");

  assert.equal(
    await storage.finishRideDispatchNoDrivers(ride.id),
    false
  );

  const savedRide = await storage.getRide(ride.id);
  assert.equal(savedRide.status, "accepted");
  assert.equal(savedRide.driverId, driver.id);

  const dispatch = await storage.getRideDispatch(ride.id);
  assert.equal(dispatch.status, "scheduled");
});
