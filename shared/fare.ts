import type { PlatformConfig, RideType } from "./schema";

export interface FareBreakdown {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  passengerFare: number;
  sharedDiscount: number;
  sharedRideDiscountPercent: number;
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
    surgePricing, surgeMultiplier, sharedRideDiscountPercent,
    passengerPricingMode, additionalPassengerFee, additionalPassengerMultiplier,
  } = config;

  const estimatedMinutes = distanceKm * (3 / 1.609344);
  const distanceFare = distanceKm * perKm;
  const timeFare = estimatedMinutes * perMinute;
  const tripSubtotal = Math.max(baseFare + distanceFare + timeFare, minimumFare);

  let passengerFare = 0;
  let totalFare = tripSubtotal;

  if (additionalPassengers > 0) {
    if (passengerPricingMode === "multiplier") {
      const factor = 1 + ((additionalPassengerMultiplier - 1) * additionalPassengers);
      totalFare = tripSubtotal * factor;
      passengerFare = totalFare - tripSubtotal;
    } else {
      passengerFare = additionalPassengerFee * additionalPassengers;
      totalFare += passengerFare;
    }
  }

  const discountPercent = Number.isFinite(sharedRideDiscountPercent)
    ? Math.max(0, Math.min(90, sharedRideDiscountPercent))
    : 15;

  const appliedDiscountPercent = rideType === "shared" ? discountPercent : 0;

  const sharedDiscount = rideType === "shared"
    ? totalFare - Math.max(minimumFare, totalFare * (1 - discountPercent / 100))
    : 0;

  totalFare -= sharedDiscount;

  if (surgePricing) totalFare *= surgeMultiplier;

  const driverPercent = driverSharePercent / 100;

  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceFare: Math.round(distanceFare * 100) / 100,
    timeFare: Math.round(timeFare * 100) / 100,
    passengerFare: Math.round(passengerFare * 100) / 100,
    sharedDiscount: Math.round(sharedDiscount * 100) / 100,
    sharedRideDiscountPercent: appliedDiscountPercent,
    totalFare: Math.round(totalFare * 100) / 100,
    driverEarnings: Math.round(totalFare * driverPercent * 100) / 100,
    platformFee: Math.round(totalFare * (1 - driverPercent) * 100) / 100,
  };
}
