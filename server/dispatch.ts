import { randomUUID } from "node:crypto";
import { calculateDistance } from "../shared/distance";
import type { RideDispatchState, IStorage } from "./storage";
import type { Ride } from "@shared/schema";
import { publishRealtimeEvent } from "./realtime";

const ACTIVE_RIDE_STATUSES = new Set([
  "accepted",
  "arriving",
  "arrived",
  "in_progress",
]);

const DISPATCH_POLL_INTERVAL_MS = 1000;
const DISPATCH_LOCK_TTL_MS = 30000;

function scheduledCommitmentConflicts(ride: Ride, existing: Ride): boolean {
  if (!ride.scheduledAt || !existing.scheduledAt) return false;
  const start = new Date(ride.scheduledAt).getTime();
  const existingStart = new Date(existing.scheduledAt).getTime();
  const durationMs = Math.max(30, Number(ride.duration) || 30) * 60_000;
  const existingDurationMs = Math.max(30, Number(existing.duration) || 30) * 60_000;
  const bufferMs = 15 * 60_000;
  return start < existingStart + existingDurationMs + bufferMs &&
    existingStart < start + durationMs + bufferMs;
}

export async function advertiseScheduledRides(storage: IStorage): Promise<void> {
  const [rides, drivers, config] = await Promise.all([
    storage.getAllRides(),
    storage.getOnlineDrivers(),
    storage.getConfig(),
  ]);

  const queued = rides.filter(ride =>
    ride.status === 'scheduled' && ride.scheduledAt && !ride.driverId &&
    new Date(ride.scheduledAt).getTime() > Date.now()
  );

  for (const ride of queued) {
    const assignedCommitments = rides.filter(existing =>
      existing.driverId &&
      existing.driverId !== ride.driverId &&
      !['completed', 'cancelled', 'no_drivers_available'].includes(existing.status) &&
      existing.scheduledAt
    );
    const requiredCapacity = ride.serviceType === 'parcel'
      ? Math.max(1, Math.round(ride.fare?.parcelMultiplier ?? 1))
      : ride.passengerCount ?? (1 + (ride.additionalPassengers ?? 0));

    const eligibleDrivers = drivers.filter(driver => {
      const capacity = driver.vehicleInfo?.seatingCapacity;
      if (
        driver.role !== 'driver' ||
        driver.suspended ||
        driver.isOnline !== true ||
        !Number.isInteger(capacity) ||
        capacity! < requiredCapacity ||
        capacity! < 1 ||
        capacity! > 8
      ) return false;

      if (assignedCommitments.some(existing => existing.driverId === driver.id && scheduledCommitmentConflicts(ride, existing))) {
        return false;
      }

      // A future booking can be advertised without a fresh GPS update. If a
      // location exists, keep the normal dispatch-radius protection.
      if (!driver.currentLocation) return true;
      return calculateDistance(
        ride.pickup.lat,
        ride.pickup.lng,
        driver.currentLocation.lat,
        driver.currentLocation.lng,
      ) <= config.dispatchMaximumRadiusKm;
    });

    for (const driver of eligibleDrivers) {
      const created = await storage.createRideOffer(
        driver.id,
        ride.id,
        config.dispatchOfferWindowSeconds,
      );
      if (!created) continue;

      console.info('[RideNotification]', JSON.stringify({
        stage: 'offer_persisted',
        rideId: ride.id,
        rideType: ride.scheduledAt ? 'scheduled' : 'immediate',
        driverId: driver.id,
        offerCreatedAt: Date.now(),
        offerExpiresAt: Date.now() + config.dispatchOfferWindowSeconds * 1000,
      }));

      const event = await storage.createEvent({
        type: 'ride_requested',
        rideId: ride.id,
        userId: driver.id,
        data: {
          pickup: ride.pickup,
          dropoff: ride.dropoff,
          fare: ride.fare,
          riderName: ride.riderName,
          serviceType: ride.serviceType,
          scheduledAt: ride.scheduledAt,
          passengerCount: ride.passengerCount,
        },
        read: false,
      });
      publishRealtimeEvent(driver.id, { type: event.type, data: event.data });
    }
  }
}

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
  const capacityRequired = ride.serviceType === 'parcel'
    ? Math.max(1, Math.round(ride.fare?.parcelMultiplier ?? 1))
    : passengerCount;

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
      capacity! < capacityRequired
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

      console.info('[RideNotification]', JSON.stringify({
        stage: 'offer_persisted',
        rideId: ride.id,
        rideType: ride.scheduledAt ? 'scheduled' : 'immediate',
        driverId: driver.id,
        offerCreatedAt: Date.now(),
        offerExpiresAt: Date.now() + config.dispatchOfferWindowSeconds * 1000,
      }));

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
            serviceType: ride.serviceType,
            scheduledAt: ride.scheduledAt,
            passengerCount: ride.passengerCount,
          },
          read: false,
        });
        publishRealtimeEvent(driver.id, {
          type: "ride_requested",
          data: {
            rideId: ride.id,
            serviceType: ride.serviceType,
            scheduledAt: ride.scheduledAt,
          },
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
      const now = Date.now();
      let allRides = await storage.getAllRides();
      // A failure in the scheduled-reservation path must not prevent normal
      // requested rides from being dispatched in the same scheduler tick.
      try {
        await advertiseScheduledRides(storage);
      } catch (error) {
        console.error("[Dispatch] Scheduled ride advertisement failed:", error);
      }
      // Re-read after advertising. A driver may accept a scheduled offer
      // while this tick is running; never activate a stale unassigned copy.
      allRides = await storage.getAllRides();
      const scheduledRides = allRides.filter(ride =>
        ride.status === 'scheduled' && ride.scheduledAt && new Date(ride.scheduledAt).getTime() <= now
      );
      for (const ride of scheduledRides) {
        await storage.activateScheduledRide(ride.id, now);
      }
      // Recover scheduled requests created by an older server instance or
      // restored without a dispatch record.
      for (const ride of allRides.filter(item => item.status === 'requested' && item.scheduledAt)) {
        const dispatchState = await storage.getRideDispatch(ride.id);
        if (!dispatchState) await storage.startRideDispatch(ride.id);
      }
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
