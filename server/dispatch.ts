import { randomUUID } from "node:crypto";
import { calculateDistance } from "../shared/distance";
import type { RideDispatchState, IStorage } from "./storage";

const ACTIVE_RIDE_STATUSES = new Set([
  "accepted",
  "arriving",
  "arrived",
  "in_progress",
]);

const DISPATCH_POLL_INTERVAL_MS = 1000;
const DISPATCH_LOCK_TTL_MS = 30000;

async function dispatchRideRound(
  storage: IStorage,
  state: RideDispatchState
): Promise<void> {
  const now = Date.now();
  const config = await storage.getConfig();
  const ride = await storage.getRide(state.rideId);

  if (!ride || ride.status !== "requested") {
    await storage.saveRideDispatch({
      ...state,
      status: "completed",
      updatedAt: Date.now(),
    });
    return;
  }

  // Recover an interrupted round before expiring or creating offers.
  const pendingExpiry = await storage.getPendingRideOfferExpiry(
    state.rideId,
    now
  );

  if (pendingExpiry < 0) {
    await storage.saveRideDispatch({
      ...state,
      status: "completed",
      updatedAt: Date.now(),
    });
    return;
  }

  if (pendingExpiry > now) {
    await storage.saveRideDispatch({
      ...state,
      nextDispatchAt: pendingExpiry,
      status: "scheduled",
      updatedAt: now,
    });
    console.log(
      `[Dispatch] Recovered ride ${state.rideId}; waiting until ${new Date(pendingExpiry).toISOString()}`
    );
    return;
  }

  // Expire the previous round before expanding.
  // Redis protects against racing with an acceptance.
  if (state.radiusKm > 0) {
    const expired = await storage.expireRideOffersForRide(state.rideId);

    if (expired < 0) {
      await storage.saveRideDispatch({
        ...state,
        status: "completed",
        updatedAt: Date.now(),
      });
      return;
    }

    const refreshedRide = await storage.getRide(state.rideId);
    if (!refreshedRide || refreshedRide.status !== "requested") {
      await storage.saveRideDispatch({
        ...state,
        status: "completed",
        updatedAt: Date.now(),
      });
      return;
    }
  }

  if (state.radiusKm >= config.dispatchMaximumRadiusKm) {
    const finished = await storage.finishRideDispatchNoDrivers(state.rideId);

    if (!finished) {
      await storage.saveRideDispatch({
        ...state,
        status: "completed",
        updatedAt: Date.now(),
      });
    }
    return;
  }

  const radiusKm = state.radiusKm === 0
    ? config.dispatchInitialRadiusKm
    : Math.min(
        config.dispatchMaximumRadiusKm,
        state.radiusKm + config.dispatchRadiusIncrementKm
      );

  const passengerCount = ride.passengerCount ??
    (1 + (ride.additionalPassengers ?? 0));

  const [onlineDrivers, allRides] = await Promise.all([
    storage.getOnlineDrivers(),
    storage.getAllRides(),
  ]);

  // Drivers with active PRIVATE rides are excluded from receiving new offers.
  // Active SHARED rides remain eligible for additional Shared offers.
  const driversWithActiveRides = new Set(
    allRides
      .filter(existingRide =>
        existingRide.driverId &&
        ACTIVE_RIDE_STATUSES.has(existingRide.status) &&
        existingRide.rideType === 'private'
      )
      .map(existingRide => existingRide.driverId as string)
  );

  const eligibleDrivers = onlineDrivers.filter(driver => {
    if (
      driver.role !== "driver" ||
      driver.isOnline !== true ||
      driver.suspended ||
      !driver.currentLocation ||
      driversWithActiveRides.has(driver.id)
    ) {
      return false;
    }

    const capacity = driver.vehicleInfo?.seatingCapacity;

    if (
      !Number.isInteger(capacity) ||
      capacity! < 1 ||
      capacity! > 8 ||
      capacity! < passengerCount
    ) {
      return false;
    }

    const distance = calculateDistance(
      ride.pickup.lat,
      ride.pickup.lng,
      driver.currentLocation.lat,
      driver.currentLocation.lng
    );

    return distance <= radiusKm;
  });

  // All eligible drivers receive the same round concurrently.
  const results = await Promise.all(
    eligibleDrivers.map(async driver => {
      let created: boolean;

      try {
        created = await storage.createRideOffer(
          driver.id,
          ride.id,
          config.dispatchOfferWindowSeconds
        );
      } catch (error) {
        console.error(`[Dispatch] Offer creation failed for driver ${driver.id}:`, error);
        return false;
      }

      if (!created) return false;

      try {
        await storage.createEvent({
          type: "ride_requested",
          rideId: ride.id,
          userId: driver.id,
          data: {
            pickup: ride.pickup,
            dropoff: ride.dropoff,
            fare: ride.fare,
            riderName: ride.riderName,
            dispatchRadiusKm: radiusKm,
          },
          read: false,
        });
      } catch (error) {
        console.error(`[Dispatch] Notification failed for driver ${driver.id}:`, error);
      }

      return true;
    })
  );

  const offersCreated = results.filter(Boolean).length;
  const updatedAt = Date.now();

  await storage.saveRideDispatch({
    rideId: ride.id,
    round: state.round + 1,
    radiusKm,
    nextDispatchAt: offersCreated > 0
      ? updatedAt + config.dispatchOfferWindowSeconds * 1000
      : updatedAt,
    status: "scheduled",
    updatedAt,
  });

  console.log(
    `[Dispatch] Ride ${ride.id}: radius ${radiusKm} km, ` +
    `${offersCreated} offers created`
  );
}

export async function processDueRideDispatches(
  storage: IStorage
): Promise<void> {
  const token = randomUUID();
  const acquired = await storage.acquireDispatchLock(
    token,
    DISPATCH_LOCK_TTL_MS
  );

  if (!acquired) return;

  try {
    const dueDispatches = await storage.getDueRideDispatches(
      Date.now(),
      20
    );

    for (const state of dueDispatches) {
      try {
        await dispatchRideRound(storage, state);
      } catch (error) {
        console.error(
          `[Dispatch] Failed processing ride ${state.rideId}:`,
          error
        );
      }
    }
  } finally {
    await storage.releaseDispatchLock(token);
  }
}

export function startDispatchScheduler(storage: IStorage): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;

    try {
      await processDueRideDispatches(storage);
    } catch (error) {
      console.error("[Dispatch] Scheduler cycle failed:", error);
    } finally {
      running = false;
    }
  };

  void tick();

  const timer = setInterval(
    () => void tick(),
    DISPATCH_POLL_INTERVAL_MS
  );

  console.log("[Dispatch] Scheduler started");

  return () => {
    clearInterval(timer);
    console.log("[Dispatch] Scheduler stopped");
  };
}
