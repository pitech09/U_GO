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

test("Private fare preserves the existing calculation", () => {
  const result = fare(10);
  close(result.totalFare, subtotal, "Private total");
  close(result.sharedDiscount, 0, "Private discount");
  assert.equal(result.sharedRideDiscountPercent, 0);
});

test("Shared fare applies the configured 15% discount", () => {
  const result = fare(10, 0, "shared");
  close(result.totalFare, subtotal * 0.85, "Shared total");
  close(result.sharedDiscount, subtotal * 0.15, "Shared discount");
  assert.equal(result.sharedRideDiscountPercent, 15);
});

test("Private fare charges for additional passengers without discount", () => {
  const result = fare(10, 2, "private");
  close(result.passengerFare, 10, "Passenger surcharge");
  close(result.totalFare, subtotal + 10, "Private total");
  close(result.sharedDiscount, 0, "Private discount");
});

test("Shared fare applies passenger charges before discount", () => {
  const result = fare(10, 2, "shared");
  close(result.passengerFare, 10, "Passenger surcharge");
  close(result.totalFare, (subtotal + 10) * 0.85, "Shared total");
});

test("Minimum fare is preserved for short trips", () => {
  const result = fare(0, 0, "shared");
  close(result.totalFare, 20, "Minimum fare");
  close(result.sharedDiscount, 0, "Minimum fare discount");
});

test("Surge pricing is applied after the Shared discount", () => {
  const result = fare(10, 0, "shared", {
    surgePricing: true,
    surgeMultiplier: 1.5,
  });
  close(result.totalFare, subtotal * 0.85 * 1.5, "Surge total");
});

test("Configured discount percentage is respected", () => {
  const result = fare(10, 0, "shared", {
    sharedRideDiscountPercent: 20,
  });
  close(result.totalFare, subtotal * 0.8, "20% discount total");
  assert.equal(result.sharedRideDiscountPercent, 20);
});

test("90% discount cap is respected on a longer trip", () => {
  const longTripSubtotal = 20 + (30 * 12) + (30 * (3 / 1.609344) * 0.35);
  const result = fare(30, 0, "shared", {
    sharedRideDiscountPercent: 120,
  });
  close(result.totalFare, longTripSubtotal * 0.1, "Capped discount total");
  assert.equal(result.sharedRideDiscountPercent, 90);
});

test("90% discount cannot reduce a fare below the minimum", () => {
  const result = fare(10, 0, "shared", {
    sharedRideDiscountPercent: 120,
  });
  close(result.totalFare, 20, "Minimum fare after discount");
  assert.equal(result.sharedRideDiscountPercent, 90);
});

test("Negative discount is clamped to zero", () => {
  const result = fare(10, 0, "shared", {
    sharedRideDiscountPercent: -10,
  });
  close(result.totalFare, subtotal, "Zero discount total");
  assert.equal(result.sharedRideDiscountPercent, 0);
});

test("Multiplier passenger pricing works", () => {
  const result = fare(10, 2, "private", {
    passengerPricingMode: "multiplier",
    additionalPassengerMultiplier: 1.1,
  });
  close(result.passengerFare, subtotal * 0.2, "Multiplier surcharge");
  close(result.totalFare, subtotal * 1.2, "Multiplier total");
});

test("Driver earnings and platform fee use the final fare", () => {
  const result = fare(10, 0, "shared");
  close(result.driverEarnings, result.totalFare * 0.88, "Driver earnings");
  close(result.platformFee, result.totalFare * 0.12, "Platform fee");
  close(
    result.driverEarnings + result.platformFee,
    result.totalFare,
    "Fare distribution"
  );
});

console.log(`\n${passed} fare tests passed.`);
