import type { PlatformConfig, RideType } from "./schema";

export interface FareBreakdown {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  passengerFare: number;
  sharedDiscount: number;
  sharedRideDiscountPercent: number;
  groupDiscountPercent: number;
  totalFare: number;
  driverEarnings: number;
  platformFee: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateFareBreakdown(
  distanceKm: number,
  config: PlatformConfig,
  additionalPassengers = 0,
  rideType: RideType = "private"
): FareBreakdown {
  const {
    baseFare, perKm, perMinute, driverSharePercent, minimumFare,
    surgePricing, surgeMultiplier,
  } = config;

  const estimatedMinutes = distanceKm * (3 / 1.609344);
  const distanceFare = distanceKm * perKm;
  const timeFare = estimatedMinutes * perMinute;
  const tripSubtotal = Math.max(baseFare + distanceFare + timeFare, minimumFare);

  const driverPercent = driverSharePercent / 100;
  const surgeMultiplierValue = surgePricing ? surgeMultiplier : 1;

  if (rideType === "private") {
    // Private rides are vehicle-based bookings. The fare is the same
    // regardless of passenger count. Passengers travelling together pay
    // ONE vehicle fare.
    const vehicleSubtotal = tripSubtotal;
    const totalFare = vehicleSubtotal * surgeMultiplierValue;

    return {
      baseFare: round2(baseFare),
      distanceFare: round2(distanceFare),
      timeFare: round2(timeFare),
      passengerFare: 0,
      sharedDiscount: 0,
      sharedRideDiscountPercent: 0,
      groupDiscountPercent: 0,
      totalFare: round2(totalFare),
      driverEarnings: round2(totalFare * driverPercent),
      platformFee: round2(totalFare * (1 - driverPercent)),
    };
  }

  // Shared rides preserve individual passenger fare calculation with
  // group discount applied when multiple passengers share the vehicle.
  const { groupDiscountPercent } = config;

  const passengerCount = 1 + Math.max(0, Math.min(7, Math.floor(additionalPassengers)));
  const groupSubtotal = tripSubtotal * passengerCount;
  const discountPercent = Number.isFinite(groupDiscountPercent)
    ? Math.max(0, Math.min(90, groupDiscountPercent))
    : 20;

  const appliedDiscountPercent = passengerCount > 1 ? discountPercent : 0;
  const sharedDiscount = passengerCount > 1
    ? groupSubtotal - Math.max(minimumFare, groupSubtotal * (1 - discountPercent / 100))
    : 0;

  let totalFare = groupSubtotal - sharedDiscount;
  if (surgePricing) totalFare *= surgeMultiplierValue;

  const passengerFare = tripSubtotal * (passengerCount - 1);

  return {
    baseFare: round2(baseFare),
    distanceFare: round2(distanceFare),
    timeFare: round2(timeFare),
    passengerFare: round2(passengerFare),
    sharedDiscount: round2(sharedDiscount),
    sharedRideDiscountPercent: 0,
    groupDiscountPercent: appliedDiscountPercent,
    totalFare: round2(totalFare),
    driverEarnings: round2(totalFare * driverPercent),
    platformFee: round2(totalFare * (1 - driverPercent)),
  };
}
