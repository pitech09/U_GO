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

// ── Private pricing tests (vehicle-based fare) ──

test("One passenger pays the normal vehicle fare", () => {
  const result = fare(10, 0, "private");
  close(result.totalFare, subtotal, "Solo private fare");
  close(result.passengerFare, 0, "No additional passenger fare");
  close(result.sharedDiscount, 0, "No group discount");
  assert.equal(result.groupDiscountPercent, 0);
  assert.equal(result.sharedRideDiscountPercent, 0);
});

test("Two passengers pay exactly the same fare as one", () => {
  const one = fare(10, 0, "private");
  const two = fare(10, 1, "private");
  close(two.totalFare, one.totalFare, "Two passengers equal one passenger");
  close(two.passengerFare, 0, "No additional passenger fare for two");
  close(two.sharedDiscount, 0, "No group discount for two");
});

test("Three passengers pay exactly the same fare as one", () => {
  const one = fare(10, 0, "private");
  const three = fare(10, 2, "private");
  close(three.totalFare, one.totalFare, "Three passengers equal one passenger");
  close(three.passengerFare, 0, "No additional passenger fare for three");
  close(three.sharedDiscount, 0, "No group discount for three");
});

test("Four passengers pay exactly the same fare as one", () => {
  const one = fare(10, 0, "private");
  const four = fare(10, 3, "private");
  close(four.totalFare, one.totalFare, "Four passengers equal one passenger");
  close(four.passengerFare, 0, "No additional passenger fare for four");
  close(four.sharedDiscount, 0, "No group discount for four");
});

test("Additional passengers do not increase the fare", () => {
  const one = fare(10, 0, "private");
  const four = fare(10, 7, "private");
  close(four.totalFare, one.totalFare, "Max passengers still pay vehicle fare");
  close(four.passengerFare, 0, "No passenger fare regardless of count");
});

test("The previous group discount does not affect Private fares", () => {
  const result = fare(10, 2, "private", {
    groupDiscountPercent: 50,
  });
  close(result.totalFare, subtotal, "Group discount ignored for Private");
  close(result.groupDiscountPercent, 0, "Group discount percent is zero for Private");
  close(result.sharedDiscount, 0, "No shared discount for Private");
});

test("The previous additional passenger surcharge does not affect Private fares", () => {
  const result = fare(10, 5, "private", {
    additionalPassengerFee: 50,
  });
  close(result.totalFare, subtotal, "Additional passenger fee ignored for Private");
  close(result.passengerFare, 0, "No passenger fare surcharge for Private");
});

test("Minimum fare safeguard still works for Private", () => {
  const result = fare(0, 0, "private");
  close(result.totalFare, 20, "Solo minimum fare");
  close(result.passengerFare, 0, "No passenger fare on minimum fare");
});

test("Minimum fare safeguard still works for Private with passengers", () => {
  const result = fare(0, 3, "private");
  close(result.totalFare, 20, "Minimum fare with multiple passengers");
  close(result.passengerFare, 0, "No passenger fare on minimum fare");
});

test("Surge pricing is applied once to the vehicle fare", () => {
  const result = fare(10, 3, "private", {
    surgePricing: true,
    surgeMultiplier: 1.5,
  });
  close(result.totalFare, subtotal * 1.5, "Surge applied once to vehicle fare");
  close(result.passengerFare, 0, "No passenger fare with surge");
});

test("Surge disabled means multiplier is 1", () => {
  const result = fare(10, 3, "private", {
    surgePricing: false,
    surgeMultiplier: 2.0,
  });
  close(result.totalFare, subtotal, "No surge when disabled");
});

test("Driver earnings use the final vehicle fare", () => {
  const result = fare(10, 3, "private");
  close(result.driverEarnings, result.totalFare * 0.88, "Driver earnings from vehicle fare");
  assert.equal(result.driverEarnings, round2(subtotal * 0.88));
});

test("Platform commission uses the final vehicle fare", () => {
  const result = fare(10, 3, "private");
  close(result.platformFee, result.totalFare * 0.12, "Platform commission from vehicle fare");
  close(
    result.driverEarnings + result.platformFee,
    result.totalFare,
    "Fare distribution equals total"
  );
});

test("Driver earnings are identical for 1, 2, 3, 4 passengers", () => {
  const e1 = fare(10, 0, "private").driverEarnings;
  const e2 = fare(10, 1, "private").driverEarnings;
  const e3 = fare(10, 2, "private").driverEarnings;
  const e4 = fare(10, 3, "private").driverEarnings;
  close(e2, e1, "Driver earnings same for 2 passengers");
  close(e3, e1, "Driver earnings same for 3 passengers");
  close(e4, e1, "Driver earnings same for 4 passengers");
});

// ── Shared pricing tests (discounted individual booking) ──

test("Shared booking uses a discounted individual fare", () => {
  const result = fare(10, 0, "shared");
  close(result.totalFare, subtotal * 0.85, "Shared discounted fare");
  close(result.sharedDiscount, subtotal * 0.15, "Shared discount");
  assert.equal(result.sharedRideDiscountPercent, 15);
  assert.equal(result.groupDiscountPercent, 0);
});

test("Additional passengers do not multiply a Shared booking fare", () => {
  const result = fare(10, 2, "shared");
  close(result.passengerFare, 0, "No additional passenger fare");
  close(result.sharedDiscount, subtotal * 0.15, "Shared discount");
  close(result.totalFare, subtotal * 0.85, "Shared individual fare");
  assert.equal(result.sharedRideDiscountPercent, 15);
  assert.equal(result.groupDiscountPercent, 0);
});

test("Private and Shared use separate pricing models", () => {
  const privateResult = fare(10, 2, "private");
  const sharedResult = fare(10, 2, "shared");
  close(privateResult.totalFare, subtotal, "Private vehicle fare");
  close(sharedResult.totalFare, subtotal * 0.85, "Shared discounted fare");
});

test("Minimum fare is preserved for Shared short trips", () => {
  const result = fare(0, 0, "shared");
  close(result.totalFare, 20, "Shared minimum fare");
  close(result.sharedDiscount, 0, "No discount below minimum fare");
});

test("Surge pricing is applied after Shared discount", () => {
  const result = fare(10, 2, "shared", {
    surgePricing: true,
    surgeMultiplier: 1.5,
  });
  close(result.totalFare, subtotal * 0.85 * 1.5, "Shared total");
});

test("Configured Shared discount percentage is respected", () => {
  const result = fare(10, 1, "shared", {
    sharedRideDiscountPercent: 25,
  });
  close(result.totalFare, subtotal * 0.75, "25% Shared discount");
  assert.equal(result.sharedRideDiscountPercent, 25);
});

test("Shared discount is capped at 90%", () => {
  const result = fare(30, 1, "shared", {
    sharedRideDiscountPercent: 120,
  });
  close(result.totalFare, (20 + 30 * 12 + 30 * (3 / 1.609344) * 0.35) * 0.1,
    "Capped Shared fare");
  assert.equal(result.sharedRideDiscountPercent, 90);
});

test("Negative Shared discount is clamped to zero", () => {
  const result = fare(10, 1, "shared", {
    sharedRideDiscountPercent: -10,
  });
  close(result.totalFare, subtotal, "Zero-discount Shared fare");
  assert.equal(result.sharedRideDiscountPercent, 0);
});

test("Shared passenger count remains booking information, not a fare multiplier", () => {
  const result = fare(10, 10, "shared");
  close(result.totalFare, subtotal * 0.85, "Shared fare independent of party count");
  close(result.passengerFare, 0, "No additional passenger fare");
});

test("Driver earnings and platform fee use the final Shared fare", () => {
  const result = fare(10, 2, "shared");
  close(result.driverEarnings, result.totalFare * 0.88, "Driver earnings");
  close(result.platformFee, result.totalFare * 0.12, "Platform fee");
  close(
    result.driverEarnings + result.platformFee,
    result.totalFare,
    "Fare distribution"
  );
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

console.log(`\n${passed} fare tests passed.`);
