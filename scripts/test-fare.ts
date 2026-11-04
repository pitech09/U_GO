import assert from "node:assert/strict";
import { calculateFareBreakdown } from "../shared/fare";
import type { PlatformConfig, RideType } from "../shared/schema";

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
  additionalPassengerFee: 5,
  additionalPassengerMultiplier: 1,
  dispatchInitialRadiusKm: 15,
  dispatchRadiusIncrementKm: 5,
  dispatchMaximumRadiusKm: 30,
  dispatchOfferWindowSeconds: 45,
};

let passed = 0;

function test(name: string, run: () => void) {
  run();
  passed++;
  console.log(`PASS: ${name}`);
}

function close(actual: number, expected: number, label: string) {
  assert.ok(
    Math.abs(actual - expected) < 0.011,
    `${label}: expected ${expected}, received ${actual}`
  );
}

function fare(
  distance: number,
  passengers = 0,
  type: RideType = "private",
  overrides: Partial<PlatformConfig> = {}
) {
  return calculateFareBreakdown(
    distance,
    { ...config, ...overrides },
    passengers,
    type
  );
}

const subtotal = 20 + (10 * 12) + (10 * (3 / 1.609344) * 0.35);

test("Solo Private booking pays normal fare", () => {
  const result = fare(10, 0, "private");
  close(result.totalFare, subtotal, "Solo private fare");
  close(result.sharedDiscount, 0, "Group discount");
  assert.equal(result.groupDiscountPercent, 0);
});

test("Solo Shared booking pays normal fare without shared discount", () => {
  const result = fare(10, 0, "shared");
  close(result.totalFare, subtotal, "Solo shared fare");
  close(result.sharedDiscount, 0, "Group discount");
  assert.equal(result.sharedRideDiscountPercent, 0);
  assert.equal(result.groupDiscountPercent, 0);
});

test("Two additional passengers receive 20% discount on the entire group fare", () => {
  const result = fare(10, 2, "private");
  close(result.passengerFare, subtotal * 2, "Additional passenger fares");
  close(result.sharedDiscount, subtotal * 3 * 0.2, "Group discount");
  close(result.totalFare, subtotal * 3 * 0.8, "Group total");
  assert.equal(result.groupDiscountPercent, 20);
});

test("Private and Shared group bookings use identical group pricing", () => {
  const privateResult = fare(10, 2, "private");
  const sharedResult = fare(10, 2, "shared");

  close(privateResult.totalFare, sharedResult.totalFare, "Ride type parity");
  close(sharedResult.totalFare, subtotal * 3 * 0.8, "Shared group total");
  assert.equal(sharedResult.sharedRideDiscountPercent, 0);
});

test("Minimum fare is preserved for solo short trips", () => {
  const result = fare(0, 0, "private");
  close(result.totalFare, 20, "Solo minimum fare");
  close(result.sharedDiscount, 0, "Solo group discount");
});

test("Minimum fare is preserved after group discount", () => {
  const result = fare(0, 1, "private", {
    groupDiscountPercent: 90,
  });
  close(result.totalFare, 20, "Group minimum fare");
});

test("Surge pricing is applied after group discount", () => {
  const result = fare(10, 2, "private", {
    surgePricing: true,
    surgeMultiplier: 1.5,
  });
  close(result.totalFare, subtotal * 3 * 0.8 * 1.5, "Surge group total");
});

test("Configured group discount percentage is respected", () => {
  const result = fare(10, 1, "private", {
    groupDiscountPercent: 25,
  });
  close(result.totalFare, subtotal * 2 * 0.75, "25% group discount");
  assert.equal(result.groupDiscountPercent, 25);
});

test("Group discount is capped at 90%", () => {
  const result = fare(30, 1, "private", {
    groupDiscountPercent: 120,
  });
  close(result.totalFare, (20 + 30 * 12 + 30 * (3 / 1.609344) * 0.35) * 2 * 0.1,
    "Capped group fare");
  assert.equal(result.groupDiscountPercent, 90);
});

test("Negative group discount is clamped to zero", () => {
  const result = fare(10, 1, "private", {
    groupDiscountPercent: -10,
  });
  close(result.totalFare, subtotal * 2, "Zero-discount group fare");
  assert.equal(result.groupDiscountPercent, 0);
});

test("Additional passenger count is capped at seven", () => {
  const result = fare(10, 10, "private");
  close(result.totalFare, subtotal * 8 * 0.8, "Maximum group fare");
  close(result.passengerFare, subtotal * 7, "Maximum additional passenger fare");
});

test("Driver earnings and platform fee use the final group fare", () => {
  const result = fare(10, 2, "private");
  close(result.driverEarnings, result.totalFare * 0.88, "Driver earnings");
  close(result.platformFee, result.totalFare * 0.12, "Platform fee");
  close(
    result.driverEarnings + result.platformFee,
    result.totalFare,
    "Fare distribution"
  );
});

console.log(`\n${passed} fare tests passed.`);
