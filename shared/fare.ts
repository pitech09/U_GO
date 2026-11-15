import type { ParcelDetails, PlatformConfig, RideType } from "./schema";

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
  parcelFare?: number;
  parcelMultiplier?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateFareBreakdown(
  distanceKm: number,
  config: PlatformConfig,
  additionalPassengers = 0,
  rideType: RideType = "private",
  parcel?: ParcelDetails
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

  // Shared rides are discounted individual bookings. Matching several
  // Shared riders into one vehicle is a dispatch concern, not a multiplier
  // on one rider's fare.
  const discountPercent = Number.isFinite(config.sharedRideDiscountPercent)
    ? Math.max(0, Math.min(90, config.sharedRideDiscountPercent))
    : 15;
  const discountedSubtotal = Math.max(
    minimumFare,
    tripSubtotal * (1 - discountPercent / 100)
  );
  const sharedDiscount = tripSubtotal - discountedSubtotal;
  const appliedDiscountPercent = sharedDiscount > 0 ? discountPercent : 0;

  let totalFare = discountedSubtotal;
  const passengerMultiplier = 1 + Math.max(0, additionalPassengers) * 0.10;
  const passengerFare = discountedSubtotal * (passengerMultiplier - 1);
  totalFare *= passengerMultiplier;
  if (surgePricing) totalFare *= surgeMultiplierValue;

  let parcelFare = 0;
  let parcelMultiplier = 1;
  if (parcel) {
    const weightUnits = Math.ceil(parcel.weightKg / 5);
    const volumeUnits = Math.ceil((parcel.lengthCm * parcel.widthCm * parcel.heightCm) / 50_000);
    parcelMultiplier = Math.max(1, weightUnits, volumeUnits);
    parcelFare = totalFare * (parcelMultiplier - 1);
    totalFare *= parcelMultiplier;
  }

  return {
    baseFare: round2(baseFare),
    distanceFare: round2(distanceFare),
    timeFare: round2(timeFare),
    passengerFare: round2(passengerFare),
    sharedDiscount: round2(sharedDiscount),
    sharedRideDiscountPercent: appliedDiscountPercent,
    groupDiscountPercent: 0,
    totalFare: round2(totalFare),
    driverEarnings: round2(totalFare * driverPercent),
    platformFee: round2(totalFare * (1 - driverPercent)),
    parcelFare: round2(parcelFare),
    parcelMultiplier,
  };
}
