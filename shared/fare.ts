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

export function calculateFareBreakdown(
  distanceKm: number,
  config: PlatformConfig,
  additionalPassengers = 0,
  rideType: RideType = "private"
): FareBreakdown {
  const {
    baseFare, perKm, perMinute, driverSharePercent, minimumFare,
    surgePricing, surgeMultiplier, groupDiscountPercent,
  } = config;

  const estimatedMinutes = distanceKm * (3 / 1.609344);
  const distanceFare = distanceKm * perKm;
  const timeFare = estimatedMinutes * perMinute;
  const tripSubtotal = Math.max(baseFare + distanceFare + timeFare, minimumFare);

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
  if (surgePricing) totalFare *= surgeMultiplier;

  const passengerFare = tripSubtotal * (passengerCount - 1);
  const driverPercent = driverSharePercent / 100;

  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceFare: Math.round(distanceFare * 100) / 100,
    timeFare: Math.round(timeFare * 100) / 100,
    passengerFare: Math.round(passengerFare * 100) / 100,
    sharedDiscount: Math.round(sharedDiscount * 100) / 100,
    sharedRideDiscountPercent: 0,
    groupDiscountPercent: appliedDiscountPercent,
    totalFare: Math.round(totalFare * 100) / 100,
    driverEarnings: Math.round(totalFare * driverPercent * 100) / 100,
    platformFee: Math.round(totalFare * (1 - driverPercent) * 100) / 100,
  };
}
