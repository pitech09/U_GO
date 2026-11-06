import express from "express";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";

import { registerRoutes } from "../server/routes";
import type { IStorage } from "../server/storage";
import type {
  User,
  Ride,
  WebhookEvent,
  PlatformConfig,
} from "../shared/schema";

import { calculateDistance } from "../shared/distance";
import { calculateFareBreakdown } from "../shared/fare";

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

const rider: User = {
  id: "test-rider",
  username: "test-rider",
  password: "not-a-real-password",
  role: "rider",
  fullName: "Test Rider",
  phone: "00000000",
  createdAt: new Date().toISOString(),
};

let driver: User = {
  id: "test-driver",
  username: "test-driver",
  password: "test-driver-password",
  role: "driver",
  fullName: "Test Driver",
  phone: "00000001",
  suspended: false,
  isOnline: false,
  createdAt: new Date().toISOString(),
  vehicleInfo: {
    make: "Toyota",
    model: "Vitz",
    year: "2015",
    color: "White",
    plate: "ABC 123",
    seatingCapacity: 4,
  },
};

const pickup = {
  lat: -29.3167,
  lng: 27.4833,
  address: "Test pickup",
};

const dropoff = {
  lat: -29.3,
  lng: 27.5,
  address: "Test dropoff",
};

let baseUrl = "";
let server: Awaited<ReturnType<typeof registerRoutes>>;

const bookings: Ride[] = [];
const bookingInputs: Array<Record<string, unknown>> = [];
let onlineDrivers: User[] = [];
const createdEvents: WebhookEvent[] = [];
const driverRides: Ride[] = [];
const requestedRides: Ride[] = [];
const offersByDriver = new Map<string, Array<Ride & { offerExpiresAt: number }>>();
const createdRideOffers: Array<{ driverId: string; rideId: string }> = [];
const rejectedRideOffers: Array<{ driverId: string; rideId: string }> = [];
const startedRideDispatches: string[] = [];

const fakeStorage = {
  getUser: async (id: string) => {
    if (id === rider.id) return rider;
    if (id === driver.id) return driver;
    return onlineDrivers.find(candidate => candidate.id === id);
  },

  updateUser: async (id: string, updates: Partial<User>) => {
    if (id !== driver.id) return undefined;
    driver = { ...driver, ...updates };
    return driver;
  },

  getOnlineDrivers: async () => [...onlineDrivers],

  getRidesByDriver: async (driverId: string) =>
    driverRides.filter(ride => ride.driverId === driverId),

  getAllRides: async () => [...requestedRides],

  startRideDispatch: async (rideId: string) => {
    const ride = bookings.find(
      candidate => candidate.id === rideId && candidate.status === "requested"
    );

    if (!ride || startedRideDispatches.includes(rideId)) return false;

    startedRideDispatches.push(rideId);
    return true;
  },

  createRideOffer: async (driverId: string, rideId: string) => {
    const ride = [...requestedRides, ...bookings].find(
      candidate => candidate.id === rideId && candidate.status === "requested"
    );

    if (!ride) return false;

    const current = offersByDriver.get(driverId) ?? [];
    if (current.some(offer => offer.id === rideId)) return false;

    current.push({
      ...ride,
      offerExpiresAt: Date.now() + 45_000,
    });

    offersByDriver.set(driverId, current);
    createdRideOffers.push({ driverId, rideId });
    return true;
  },

  getDriverRideOffers: async (driverId: string) =>
    [...(offersByDriver.get(driverId) ?? [])],

  rejectRideOffer: async (driverId: string, rideId: string) => {
    const current = offersByDriver.get(driverId) ?? [];
    const remaining = current.filter(offer => offer.id !== rideId);

    if (remaining.length === current.length) return false;

    offersByDriver.set(driverId, remaining);
    rejectedRideOffers.push({ driverId, rideId });
    return true;
  },

  createEvent: async (
    event: Omit<WebhookEvent, "id" | "createdAt">
  ): Promise<WebhookEvent> => {
    const created: WebhookEvent = {
      ...event,
      id: `event-${createdEvents.length + 1}`,
      createdAt: new Date().toISOString(),
    };

    createdEvents.push(created);
    return created;
  },

  calculateFareForDistance: async (
    distanceKm: number,
    additionalPassengers = 0,
    rideType: "private" | "shared" = "private"
  ) => calculateFareBreakdown(
    distanceKm,
    config,
    additionalPassengers,
    rideType
  ),

  createRide: async (
    input: Omit<Ride, "id" | "createdAt">
  ): Promise<Ride> => {
    bookingInputs.push({ ...input });

    const distance = calculateDistance(
      input.pickup.lat,
      input.pickup.lng,
      input.dropoff.lat,
      input.dropoff.lng
    );

    const additionalPassengers = input.additionalPassengers ?? 0;
    const rideType = input.rideType ?? "private";

    const fare = calculateFareBreakdown(
      distance,
      config,
      additionalPassengers,
      rideType
    );

    const ride: Ride = {
      ...input,
      id: `test-ride-${bookings.length + 1}`,
      createdAt: new Date().toISOString(),
      rideType,
      additionalPassengers,
      passengerCount: 1 + additionalPassengers,
      distance: Math.round(distance * 10) / 10,
      duration: Math.round(distance * (3 / 1.609344)),
      fare,
    };

    bookings.push(ride);
    return ride;
  },
};

before(async () => {
  const app = express();
  app.use(express.json());

  server = await registerRoutes(app, fakeStorage as unknown as IStorage);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not determine test server address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

function estimateUrl(rideType: string, additionalPassengers = 0) {
  const params = new URLSearchParams({
    pLat: String(pickup.lat),
    pLng: String(pickup.lng),
    dLat: String(dropoff.lat),
    dLng: String(dropoff.lng),
    rideType,
    additionalPassengers: String(additionalPassengers),
  });

  return `${baseUrl}/api/fare/estimate?${params}`;
}

test("Private fare estimate uses the private fare calculation", async () => {
  const response = await fetch(estimateUrl("private"));
  assert.equal(response.status, 200);

  const result = await response.json() as {
    totalFare: number;
    sharedDiscount: number;
    sharedRideDiscountPercent: number;
  };

  const distance = calculateDistance(
    pickup.lat,
    pickup.lng,
    dropoff.lat,
    dropoff.lng
  );

  const expected = calculateFareBreakdown(distance, config, 0, "private");

  assert.equal(result.totalFare, expected.totalFare);
  assert.equal(result.sharedDiscount, 0);
  assert.equal(result.sharedRideDiscountPercent, 0);
});

test("Solo Shared fare estimate does not apply a group discount", async () => {
  const response = await fetch(estimateUrl("shared"));
  assert.equal(response.status, 200);

  const result = await response.json() as {
    totalFare: number;
    sharedDiscount: number;
    sharedRideDiscountPercent: number;
    groupDiscountPercent: number;
  };

  const distance = calculateDistance(
    pickup.lat,
    pickup.lng,
    dropoff.lat,
    dropoff.lng
  );

  const expected = calculateFareBreakdown(distance, config, 0, "shared");

  assert.equal(result.totalFare, expected.totalFare);
  assert.equal(result.sharedDiscount, 0);
  assert.equal(result.sharedRideDiscountPercent, 0);
  assert.equal(result.groupDiscountPercent, 0);
});

test("Shared estimate forwards additional passenger count", async () => {
  const response = await fetch(estimateUrl("shared", 2));
  assert.equal(response.status, 200);

  const result = await response.json() as {
    passengerFare: number;
    totalFare: number;
  };

  const distance = calculateDistance(
    pickup.lat,
    pickup.lng,
    dropoff.lat,
    dropoff.lng
  );

  const expected = calculateFareBreakdown(distance, config, 2, "shared");

  assert.equal(result.passengerFare, expected.passengerFare);
  assert.equal(result.totalFare, expected.totalFare);
});

test("Invalid ride type is rejected by fare estimate", async () => {
  const response = await fetch(estimateUrl("economy"));
  assert.equal(response.status, 400);
});

test("Shared booking preserves ride type and passenger count", async () => {
  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      rideType: "shared",
      additionalPassengers: 2,
      pickup,
      dropoff,
    }),
  });

  assert.equal(response.status, 200);

  const ride = await response.json() as Ride;

  assert.equal(ride.rideType, "shared");
  assert.equal(ride.additionalPassengers, 2);
  assert.equal(ride.passengerCount, 3);
  assert.equal(ride.fare?.sharedRideDiscountPercent, 0);
  assert.equal(ride.fare?.groupDiscountPercent, 20);
  assert.ok((ride.fare?.sharedDiscount ?? 0) > 0);

  const captured = bookingInputs.at(-1);
  assert.equal(captured?.rideType, "shared");
  assert.equal(captured?.additionalPassengers, 2);
});

test("Private booking remains undiscounted", async () => {
  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      rideType: "private",
      additionalPassengers: 0,
      pickup,
      dropoff,
    }),
  });

  assert.equal(response.status, 200);

  const ride = await response.json() as Ride;

  assert.equal(ride.rideType, "private");
  assert.equal(ride.passengerCount, 1);
  assert.equal(ride.fare?.sharedDiscount, 0);
});

test("Booking rejects more than seven additional passengers", async () => {
  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      rideType: "shared",
      additionalPassengers: 8,
      pickup,
      dropoff,
    }),
  });

  assert.equal(response.status, 400);
});

test("Fare estimate rejects missing coordinates", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=${pickup.lat}&pLng=${pickup.lng}&dLat=${dropoff.lat}`
  );
  assert.equal(response.status, 400);
});

test("Fare estimate rejects non-numeric coordinates", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=abc&pLng=${pickup.lng}&dLat=${dropoff.lat}&dLng=${dropoff.lng}`
  );
  assert.equal(response.status, 400);
});

test("Fare estimate rejects out-of-range latitude", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=91&pLng=${pickup.lng}&dLat=${dropoff.lat}&dLng=${dropoff.lng}`
  );
  assert.equal(response.status, 400);
});

test("Fare estimate rejects out-of-range longitude", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=${pickup.lat}&pLng=181&dLat=${dropoff.lat}&dLng=${dropoff.lng}`
  );
  assert.equal(response.status, 400);
});

test("Fare estimate rejects decimal passenger counts", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=${pickup.lat}&pLng=${pickup.lng}&dLat=${dropoff.lat}&dLng=${dropoff.lng}&additionalPassengers=1.5`
  );
  assert.equal(response.status, 400);
});

test("Fare estimate rejects more than seven additional passengers", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=${pickup.lat}&pLng=${pickup.lng}&dLat=${dropoff.lat}&dLng=${dropoff.lng}&additionalPassengers=8`
  );
  assert.equal(response.status, 400);
});

test("Fare estimate rejects duplicate coordinate parameters", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=${pickup.lat}&pLat=${pickup.lat}&pLng=${pickup.lng}&dLat=${dropoff.lat}&dLng=${dropoff.lng}`
  );
  assert.equal(response.status, 400);
});

test("Fare estimate rejects duplicate passenger parameters", async () => {
  const response = await fetch(
    `${baseUrl}/api/fare/estimate?pLat=${pickup.lat}&pLng=${pickup.lng}&dLat=${dropoff.lat}&dLng=${dropoff.lng}&additionalPassengers=1&additionalPassengers=2`
  );
  assert.equal(response.status, 400);
});

test("Booking rejects invalid pickup latitude", async () => {
  const countBefore = bookingInputs.length;

  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      pickup: { ...pickup, lat: 91 },
      dropoff,
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(bookingInputs.length, countBefore);
});

test("Booking rejects invalid dropoff longitude", async () => {
  const countBefore = bookingInputs.length;

  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      pickup,
      dropoff: { ...dropoff, lng: 181 },
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(bookingInputs.length, countBefore);
});

test("Booking rejects blank pickup address", async () => {
  const countBefore = bookingInputs.length;

  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      pickup: { ...pickup, address: "   " },
      dropoff,
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(bookingInputs.length, countBefore);
});

test("Booking rejects blank dropoff address", async () => {
  const countBefore = bookingInputs.length;

  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      pickup,
      dropoff: { ...dropoff, address: "" },
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(bookingInputs.length, countBefore);
});


test("Driver can update vehicle details and seating capacity", async () => {
  const vehicleInfo = {
    make: "Toyota",
    model: "Corolla",
    year: "2018",
    color: "Silver",
    plate: "LS 1234",
    seatingCapacity: 5,
  };

  const response = await fetch(`${baseUrl}/api/user/${driver.id}/vehicle`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vehicleInfo }),
  });

  assert.equal(response.status, 200);

  const result = await response.json() as User;

  assert.deepEqual(result.vehicleInfo, vehicleInfo);
  assert.equal(result.id, driver.id);
  assert.equal("password" in result, false);
  assert.deepEqual(driver.vehicleInfo, vehicleInfo);
});

test("Rider cannot update driver vehicle details", async () => {
  const response = await fetch(`${baseUrl}/api/user/${rider.id}/vehicle`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vehicleInfo: {
        make: "Toyota",
        model: "Vitz",
        year: "2015",
        color: "White",
        plate: "ABC 123",
        seatingCapacity: 4,
      },
    }),
  });

  assert.equal(response.status, 403);
});

test("Vehicle update rejects missing users", async () => {
  const response = await fetch(`${baseUrl}/api/user/unknown-driver/vehicle`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vehicleInfo: {
        make: "Toyota",
        model: "Vitz",
        year: "2015",
        color: "White",
        plate: "ABC 123",
        seatingCapacity: 4,
      },
    }),
  });

  assert.equal(response.status, 404);
});

test("Vehicle update rejects invalid seating capacities", async (t) => {
  const invalidCapacities = [0, 9, 1.5, "4"];

  for (const capacity of invalidCapacities) {
    await t.test(`rejects capacity ${JSON.stringify(capacity)}`, async () => {
      const response = await fetch(`${baseUrl}/api/user/${driver.id}/vehicle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicleInfo: {
            make: "Toyota",
            model: "Vitz",
            year: "2015",
            color: "White",
            plate: "ABC 123",
            seatingCapacity: capacity,
          },
        }),
      });

      assert.equal(response.status, 400);
    });
  }
});

test("Vehicle update rejects incomplete vehicle details", async () => {
  const response = await fetch(`${baseUrl}/api/user/${driver.id}/vehicle`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vehicleInfo: {
        make: "Toyota",
        model: "Vitz",
        year: "2015",
        color: "White",
        plate: "",
        seatingCapacity: 4,
      },
    }),
  });

  assert.equal(response.status, 400);
});


test("Driver with valid seating capacity can go online", async () => {
  driver = {
    ...driver,
    isOnline: false,
    suspended: false,
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2015",
      color: "White",
      plate: "ABC 123",
      seatingCapacity: 4,
    },
  };

  const response = await fetch(`${baseUrl}/api/user/${driver.id}/online`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOnline: true }),
  });

  assert.equal(response.status, 200);

  const result = await response.json() as User;
  assert.equal(result.isOnline, true);
  assert.equal("password" in result, false);
});

test("Driver without seating capacity cannot go online", async () => {
  driver = {
    ...driver,
    isOnline: false,
    vehicleInfo: undefined,
  };

  const response = await fetch(`${baseUrl}/api/user/${driver.id}/online`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOnline: true }),
  });

  assert.equal(response.status, 409);

  const result = await response.json() as { code: string };
  assert.equal(result.code, "capacity_unverified");
  assert.equal(driver.isOnline, false);
});

test("Rider cannot change driver online status", async () => {
  const response = await fetch(`${baseUrl}/api/user/${rider.id}/online`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOnline: true }),
  });

  assert.equal(response.status, 403);
});

test("Suspended driver cannot go online", async () => {
  driver = {
    ...driver,
    isOnline: false,
    suspended: true,
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2015",
      color: "White",
      plate: "ABC 123",
      seatingCapacity: 4,
    },
  };

  const response = await fetch(`${baseUrl}/api/user/${driver.id}/online`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOnline: true }),
  });

  assert.equal(response.status, 403);
  assert.equal(driver.isOnline, false);
});

test("Driver can go offline even when suspended", async () => {
  driver = {
    ...driver,
    isOnline: true,
    suspended: true,
  };

  const response = await fetch(`${baseUrl}/api/user/${driver.id}/online`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOnline: false }),
  });

  assert.equal(response.status, 200);

  const result = await response.json() as User;
  assert.equal(result.isOnline, false);
});

test("Online status update rejects non-boolean values", async () => {
  const response = await fetch(`${baseUrl}/api/user/${driver.id}/online`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isOnline: "true" }),
  });

  assert.equal(response.status, 400);
});

test("Nearby drivers returns only eligible drivers and public vehicle details", async () => {
  const makeCandidate = (
    id: string,
    overrides: Partial<User> = {}
  ): User => ({
    ...driver,
    id,
    username: `private-${id}`,
    password: `secret-${id}`,
    fullName: `Driver ${id}`,
    phone: `private-phone-${id}`,
    role: "driver",
    suspended: false,
    isOnline: true,
    currentLocation: { lat: pickup.lat, lng: pickup.lng },
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2015",
      color: "White",
      plate: "ABC 123",
      seatingCapacity: 4,
    },
    ...overrides,
  });

  const eligible = makeCandidate("eligible");
  const admin = makeCandidate("admin", { role: "admin" });
  const suspended = makeCandidate("suspended", { suspended: true });
  const offline = makeCandidate("offline", { isOnline: false });
  const unverified = makeCandidate("unverified", {
    vehicleInfo: undefined,
  });
  const invalidCapacity = makeCandidate("invalid-capacity", {
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2015",
      color: "White",
      plate: "ABC 123",
      seatingCapacity: 0,
    },
  });
  const noLocation = makeCandidate("no-location", {
    currentLocation: undefined,
  });
  const excluded = makeCandidate("excluded");

  onlineDrivers = [
    eligible,
    admin,
    suspended,
    offline,
    unverified,
    invalidCapacity,
    noLocation,
    excluded,
  ];

  const response = await fetch(
    `${baseUrl}/api/drivers/nearby?lat=${pickup.lat}&lng=${pickup.lng}&radius=10&exclude=excluded`
  );

  assert.equal(response.status, 200);

  const results = await response.json() as Array<Record<string, any>>;

  assert.equal(results.length, 1);
  assert.equal(results[0].id, "eligible");

  assert.deepEqual(
    Object.keys(results[0]).sort(),
    ["currentLocation", "distance", "fullName", "id", "vehicleInfo"].sort()
  );

  assert.deepEqual(
    Object.keys(results[0].vehicleInfo).sort(),
    ["color", "make", "model", "plate", "seatingCapacity", "year"].sort()
  );

  assert.equal("password" in results[0], false);
  assert.equal("username" in results[0], false);
  assert.equal("phone" in results[0], false);
  assert.equal("suspended" in results[0], false);
  assert.equal("role" in results[0], false);
});

test("Ride booking starts persistent dispatch without immediately broadcasting offers", async () => {
  onlineDrivers = [];
  driverRides.length = 0;

  const response = await fetch(`${baseUrl}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riderId: rider.id,
      rideType: "private",
      additionalPassengers: 3,
      pickup,
      dropoff,
    }),
  });

  assert.equal(response.status, 200);

  const ride = await response.json() as Ride;
  assert.equal(ride.passengerCount, 4);

  assert.ok(
    startedRideDispatches.includes(ride.id),
    "booking must persist dispatch state for the scheduler"
  );

  assert.equal(
    createdRideOffers.some(offer => offer.rideId === ride.id),
    false,
    "driver offers must be created by the scheduler, not the booking route"
  );

  const driverNotifications = createdEvents.filter(
    event =>
      event.rideId === ride.id &&
      event.type === "ride_requested" &&
      event.userId !== rider.id
  );

  assert.equal(
    driverNotifications.length,
    0,
    "booking must not immediately notify drivers"
  );
});

function makeOfferTestRide(
  id: string,
  passengerCount: number
): Ride {
  return {
    id,
    riderId: rider.id,
    status: "requested",
    rideType: "private",
    additionalPassengers: passengerCount - 1,
    passengerCount,
    pickup,
    dropoff,
    createdAt: new Date().toISOString(),
  };
}

function makeOfferTestDriver(
  id: string,
  capacity: number,
  overrides: Partial<User> = {}
): User {
  return {
    ...driver,
    id,
    username: `offer-${id}`,
    fullName: `Offer Driver ${id}`,
    role: "driver",
    suspended: false,
    isOnline: true,
    currentLocation: { lat: pickup.lat, lng: pickup.lng },
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2015",
      color: "White",
      plate: "ABC 123",
      seatingCapacity: capacity,
    },
    ...overrides,
  };
}

function resetOfferTestState() {
  onlineDrivers = [];
  requestedRides.length = 0;
  driverRides.length = 0;
  offersByDriver.clear();
  createdRideOffers.length = 0;
  rejectedRideOffers.length = 0;
}

test("Driver offer polling only retrieves already-broadcast offers", async () => {
  resetOfferTestState();

  const eligible = makeOfferTestDriver("offer-eligible", 4);
  const tooSmall = makeOfferTestDriver("offer-too-small", 2);
  onlineDrivers = [eligible, tooSmall];

  const partyFour = makeOfferTestRide("offer-party-four", 4);
  const partyTwo = makeOfferTestRide("offer-party-two", 2);
  requestedRides.push(partyFour, partyTwo);

  offersByDriver.set(eligible.id, [
    { ...partyFour, offerExpiresAt: Date.now() + 45_000 },
    { ...partyTwo, offerExpiresAt: Date.now() + 45_000 },
  ]);
  offersByDriver.set(tooSmall.id, [
    { ...partyFour, offerExpiresAt: Date.now() + 45_000 },
    { ...partyTwo, offerExpiresAt: Date.now() + 45_000 },
  ]);

  const eligibleResponse = await fetch(
    `${baseUrl}/api/rides/driver/${eligible.id}/offers`
  );
  assert.equal(eligibleResponse.status, 200);
  const eligibleOffers = await eligibleResponse.json() as Ride[];
  assert.deepEqual(
    eligibleOffers.map(ride => ride.id).sort(),
    ["offer-party-four", "offer-party-two"]
  );

  const smallResponse = await fetch(
    `${baseUrl}/api/rides/driver/${tooSmall.id}/offers`
  );
  assert.equal(smallResponse.status, 200);
  const smallOffers = await smallResponse.json() as Ride[];
  assert.deepEqual(smallOffers.map(ride => ride.id), ["offer-party-two"]);

  assert.deepEqual(rejectedRideOffers, [{
    driverId: tooSmall.id,
    rideId: partyFour.id,
  }]);
  assert.equal(createdRideOffers.length, 0, "polling must not create offers");

  resetOfferTestState();
});

test("Driver offer endpoint excludes ineligible drivers and drivers with active rides", async () => {
  resetOfferTestState();

  const admin = makeOfferTestDriver("offer-admin", 4, {
    role: "admin",
  });
  const suspended = makeOfferTestDriver("offer-suspended", 4, {
    suspended: true,
  });
  const offline = makeOfferTestDriver("offer-offline", 4, {
    isOnline: false,
  });
  const noLocation = makeOfferTestDriver("offer-no-location", 4, {
    currentLocation: undefined,
  });
  const noCapacity = makeOfferTestDriver("offer-no-capacity", 4, {
    vehicleInfo: undefined,
  });
  const invalidCapacity = makeOfferTestDriver("offer-invalid-capacity", 4, {
    vehicleInfo: {
      make: "Toyota",
      model: "Vitz",
      year: "2015",
      color: "White",
      plate: "ABC 123",
      seatingCapacity: 0,
    },
  });
  const activeDriver = makeOfferTestDriver("offer-active-driver", 4);

  onlineDrivers = [
    admin,
    suspended,
    offline,
    noLocation,
    noCapacity,
    invalidCapacity,
    activeDriver,
  ];

  requestedRides.push(makeOfferTestRide("offer-active-test-ride", 1));

  driverRides.push({
    id: "offer-existing-active-ride",
    riderId: rider.id,
    driverId: activeDriver.id,
    status: "in_progress",
    pickup,
    dropoff,
    createdAt: new Date().toISOString(),
  });

  for (const candidate of onlineDrivers) {
    const response = await fetch(
      `${baseUrl}/api/rides/driver/${candidate.id}/offers`
    );

    assert.equal(response.status, 200, `${candidate.id} should return HTTP 200`);

    const offers = await response.json() as Ride[];
    assert.deepEqual(offers, [], `${candidate.id} should receive no offers`);
  }

  assert.equal(createdRideOffers.length, 0);
  resetOfferTestState();
});

test("Driver offer endpoint rejects previously queued offers that exceed capacity", async () => {
  resetOfferTestState();

  const candidate = makeOfferTestDriver("offer-reject-incompatible", 2);
  onlineDrivers = [candidate];

  const incompatibleRide = makeOfferTestRide("offer-incompatible-queued", 3);

  offersByDriver.set(candidate.id, [{
    ...incompatibleRide,
    offerExpiresAt: Date.now() + 45_000,
  }]);

  const response = await fetch(
    `${baseUrl}/api/rides/driver/${candidate.id}/offers`
  );

  assert.equal(response.status, 200);

  const offers = await response.json() as Ride[];
  assert.deepEqual(offers, []);

  assert.deepEqual(rejectedRideOffers, [{
    driverId: candidate.id,
    rideId: incompatibleRide.id,
  }]);

  assert.deepEqual(offersByDriver.get(candidate.id), []);
  resetOfferTestState();
});

