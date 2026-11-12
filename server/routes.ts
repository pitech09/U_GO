import { calculateDistance } from "../shared/distance";
import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import { storage, type IStorage } from "./storage";
import { registerSchema, loginSchema, requestRideSchema, updateLocationSchema, updateVehicleSchema } from "@shared/schema";
import type { RideStatus } from "@shared/schema";

function getRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}



async function geoapifyRequest(endpoint: string, params: Record<string, string>): Promise<any> {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEOAPIFY_API_KEY is not configured");
  }

  const url = new URL(`https://api.geoapify.com/v1/geocode/${endpoint}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Geoapify returned HTTP ${response.status}`);
  }

  return response.json();
}

async function searchGeoapify(query: string): Promise<any[]> {
  const data = await geoapifyRequest("autocomplete", {
    text: query,
    format: "json",
    limit: "5",
    lang: "en",
    filter: "countrycode:ls",
  });

  return (data.results ?? []).map((item: any) => ({
    place_id: item.place_id,
    display_name: item.formatted,
    lat: String(item.lat),
    lon: String(item.lon),
  }));
}

async function reverseGeocodeGeoapify(lat: number, lon: number): Promise<string | null> {
  const data = await geoapifyRequest("reverse", {
    lat: String(lat),
    lon: String(lon),
    format: "json",
    lang: "en",
    countrycodes: "ls",
  });

  return data.results?.[0]?.formatted ?? null;
}

export async function registerRoutes(app: Express, routeStorage: IStorage = storage): Promise<Server> {

  app.get("/api/geocode/search", async (req: Request, res: Response) => {
    const query = typeof req.query.q === "string"
      ? req.query.q.trim()
      : "";

    if (query.length < 3) {
      return res.status(400).json({ message: "Enter at least 3 characters." });
    }

    if (query.length > 200) {
      return res.status(400).json({ message: "Search query is too long." });
    }

    try {
      const results = await searchGeoapify(query);
      return res.json(results);
    } catch (error) {
      console.error("Destination geocoding failed:", error);
      return res.status(502).json({
        message: "Destination search is temporarily unavailable. Please try again.",
      });
    }
  });

  app.get("/api/geocode/reverse", async (req: Request, res: Response) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ message: "Valid latitude and longitude are required." });
    }

    try {
      const displayName = await reverseGeocodeGeoapify(lat, lon);
      return res.json({ display_name: displayName });
    } catch (error) {
      console.error("Reverse geocoding failed:", error);
      return res.status(502).json({
        message: "Location lookup is temporarily unavailable.",
      });
    }
  });

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const parsed = registerSchema.parse(req.body);
      const existing = await routeStorage.getUserByUsername(parsed.username);
      if (existing) {
        return res.status(400).json({ message: "Username already taken" });
      }
      const user = await routeStorage.createUser({
        username: parsed.username,
        password: parsed.password,
        role: parsed.role,
        fullName: parsed.fullName,
        phone: parsed.phone,
        isOnline: false,
        vehicleInfo: parsed.vehicleInfo,
        rating: parsed.role === 'driver' ? 5.0 : undefined,
        totalRides: 0,
        totalEarnings: 0,
      });
      const { password: _, ...safe } = user;
      return res.json(safe);
    } catch (e: any) {
      return res.status(400).json({ message: e.message || "Invalid data" });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.parse(req.body);
      const user = await routeStorage.getUserByUsername(parsed.username);
      if (!user || user.password !== parsed.password) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      const { password: _, ...safe } = user;
      return res.json(safe);
    } catch (e: any) {
      return res.status(400).json({ message: e.message || "Invalid data" });
    }
  });

  app.get("/api/user/:id", async (req: Request, res: Response) => {
    const user = await routeStorage.getUser(getRouteParam(req.params.id));
    if (!user) return res.status(404).json({ message: "User not found" });
    const { password: _, ...safe } = user;
    return res.json(safe);
  });

  app.put("/api/user/:id/vehicle", async (req: Request, res: Response) => {
    try {
      const userId = getRouteParam(req.params.id);
      const user = await routeStorage.getUser(userId);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (user.role !== "driver") {
        return res.status(403).json({ message: "Only driver accounts can update vehicle details." });
      }

      const parsed = updateVehicleSchema.parse(req.body);
      const updated = await routeStorage.updateUser(userId, {
        vehicleInfo: parsed.vehicleInfo,
      });

      if (!updated) {
        return res.status(404).json({ message: "User not found" });
      }

      const { password: _, ...safe } = updated;
      return res.json(safe);
    } catch (e: any) {
      return res.status(400).json({ message: e.message || "Invalid vehicle details" });
    }
  });

  app.put("/api/user/:id/location", async (req: Request, res: Response) => {
    try {
      const parsed = updateLocationSchema.parse(req.body);
      const user = await routeStorage.updateUser(getRouteParam(req.params.id), {
        currentLocation: { lat: parsed.lat, lng: parsed.lng },
      });
      if (!user) return res.status(404).json({ message: "User not found" });
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(400).json({ message: e.message });
    }
  });

  app.put("/api/user/:id/online", async (req: Request, res: Response) => {
    try {
      const userId = getRouteParam(req.params.id);
      const { isOnline } = req.body;

      if (typeof isOnline !== "boolean") {
        return res.status(400).json({ message: "isOnline must be a boolean" });
      }

      const existing = await routeStorage.getUser(userId);
      if (!existing) return res.status(404).json({ message: "User not found" });

      if (existing.role !== "driver") {
        return res.status(403).json({ message: "Only registered drivers can change driver status" });
      }

      if (isOnline) {
        if (existing.suspended) {
          return res.status(403).json({ message: "Your driver account is suspended" });
        }

        const capacity = Number(existing.vehicleInfo?.seatingCapacity);
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
          return res.status(409).json({
            code: "capacity_unverified",
            message: "Update your vehicle details and passenger capacity before going online",
          });
        }
      }

      const user = await routeStorage.updateUser(userId, { isOnline });
      if (!user) return res.status(404).json({ message: "User not found" });

      const { password: _, ...safe } = user;
      return res.json(safe);
    } catch (e: any) {
      return res.status(500).json({ message: e.message || "Could not update driver status" });
    }
  });

  app.get("/api/drivers/nearby", async (req: Request, res: Response) => {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radius = parseFloat(req.query.radius as string) || 10;
    const excludeId = req.query.exclude as string;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ message: "lat and lng required" });
    }

    const onlineDrivers = await routeStorage.getOnlineDrivers();
    const nearby = onlineDrivers
      .filter(d =>
        d.role === "driver" &&
        d.isOnline === true &&
        !d.suspended &&
        d.id !== excludeId &&
        !!d.currentLocation &&
        Number.isInteger(d.vehicleInfo?.seatingCapacity) &&
        d.vehicleInfo!.seatingCapacity! >= 1 &&
        d.vehicleInfo!.seatingCapacity! <= 8
      )
      .map(d => {
        const location = d.currentLocation!;
        const vehicle = d.vehicleInfo!;
        const dist = calculateDistance(lat, lng, location.lat, location.lng);

        return {
          id: d.id,
          fullName: d.fullName,
          currentLocation: {
            lat: location.lat,
            lng: location.lng,
          },
          vehicleInfo: {
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            color: vehicle.color,
            plate: vehicle.plate,
            seatingCapacity: vehicle.seatingCapacity,
          },
          distance: Math.round(dist * 10) / 10,
        };
      })
      .filter(d => d.distance <= radius)
      .sort((a, b) => a.distance - b.distance);

    return res.json(nearby);
  });

  app.post("/api/rides", async (req: Request, res: Response) => {
    try {
      const parsed = requestRideSchema.parse(req.body);
      const riderId = req.body.riderId;
      if (!riderId) return res.status(400).json({ message: "riderId required" });

      const rider = await routeStorage.getUser(riderId);
      if (!rider) return res.status(404).json({ message: "Rider not found" });

      const ride = await routeStorage.createRide({
        riderId,
        status: 'requested',
        pickup: parsed.pickup,
        dropoff: parsed.dropoff,
        rideType: parsed.rideType,
        additionalPassengers: parsed.additionalPassengers,
        riderName: rider.fullName,
      });

      await routeStorage.createEvent({
        type: 'ride_requested',
        rideId: ride.id,
        userId: riderId,
        data: { pickup: ride.pickup, dropoff: ride.dropoff, fare: ride.fare },
        read: false,
      });

      // Persist dispatch state. The scheduler broadcasts to all eligible
      // nearby drivers and expands the radius when nobody accepts.
      await routeStorage.startRideDispatch(ride.id);

      return res.json(ride);
    } catch (e: any) {
      return res.status(400).json({ message: e.message });
    }
  });

  app.put("/api/rides/:id/payment", async (req: Request, res: Response) => {
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (ride.riderId !== req.body.riderId) {
      return res.status(403).json({ message: "Only the rider can submit this payment" });
    }
    if (ride.status !== 'in_progress') {
      return res.status(409).json({ message: "Payment can be initiated after the ride has started" });
    }

    const method = req.body.paymentMethod;
    if (!['cash', 'mpesa', 'ecocash'].includes(method)) {
      return res.status(400).json({ message: "Choose cash, M-Pesa, or EcoCash" });
    }

    const reference = typeof req.body.paymentReference === 'string'
      ? req.body.paymentReference.trim()
      : '';
    if (method !== 'cash' && !reference) {
      return res.status(400).json({ message: "A mobile-money transaction reference is required" });
    }

    const proofImage = req.body.paymentProofImage;
    if (proofImage !== undefined && (
      typeof proofImage !== 'string' ||
      proofImage.length > 6_000_000 ||
      !/^data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(proofImage)
    )) {
      return res.status(400).json({ message: "Payment proof must be a PNG or JPEG image" });
    }

    const updated = await routeStorage.updateRide(ride.id, {
      payment: {
        method,
        status: method === 'cash' ? 'pending_cash' : 'pending_verification',
        transactionReference: reference || undefined,
        proofImage,
        submittedAt: new Date().toISOString(),
      },
    });

    return res.json(updated);
  });

  app.put("/api/admin/rides/:id/payment", async (req: Request, res: Response) => {
    const { status, adminId } = req.body as { status?: string; adminId?: string };
    if (!adminId) return res.status(400).json({ message: "adminId required" });

    const admin = await routeStorage.getUser(adminId);
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ message: "Admin access required" });
    }

    if (status !== 'paid' && status !== 'rejected') {
      return res.status(400).json({ message: "Payment status must be paid or rejected" });
    }

    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride?.payment) return res.status(404).json({ message: "Payment not found" });

    const updated = await routeStorage.updateRide(ride.id, {
      payment: {
        ...ride.payment,
        status,
        verifiedAt: new Date().toISOString(),
        verifiedBy: admin.id,
      },
    });

    return res.json(updated);
  });

  app.get("/api/rides/available", async (_req: Request, res: Response) => {
    const active = await routeStorage.getActiveRides();
    const requested = active.filter(r => r.status === 'requested');
    return res.json(requested);
  });

  app.get("/api/rides/rider/:riderId/offers", async (req: Request, res: Response) => {
    try {
      const riderId = getRouteParam(req.params.riderId);
      const offers = await routeStorage.getRideOffersForRider(riderId);
      return res.json(offers);
    } catch (e: any) {
      return res.status(500).json({ message: e.message || "Could not fetch ride offers" });
    }
  });

  app.get("/api/rides/rider/:riderId", async (req: Request, res: Response) => {
    const rides = await routeStorage.getRidesByRider(getRouteParam(req.params.riderId));
    const sanitized = rides.map(r => {
      if (r.review) return { ...r, review: { rating: r.review.rating, createdAt: r.review.createdAt } };
      return r;
    });
    return res.json(sanitized);
  });

  app.get("/api/rides/driver/:driverId/offers", async (req: Request, res: Response) => {
    try {
      const driverId = getRouteParam(req.params.driverId);
      const driver = await routeStorage.getUser(driverId);

      if (!driver) return res.status(404).json({ message: "Driver not found" });

      const capacity = Number(driver.vehicleInfo?.seatingCapacity);
      if (
        driver.role !== "driver" ||
        driver.suspended ||
        !driver.isOnline ||
        !driver.currentLocation ||
        !Number.isInteger(capacity) ||
        capacity < 1 ||
        capacity > 8
      ) {
        return res.json([]);
      }

      const driverRides = await routeStorage.getRidesByDriver(driverId);
      const activeRide = driverRides.find(
        ride => !['completed', 'cancelled'].includes(ride.status)
      );

      // A driver with an active PRIVATE ride cannot receive new offers.
      // A driver with an active SHARED ride can still receive eligible offers.
      if (activeRide && activeRide.rideType === 'private') {
        return res.json([]);
      }

      // Remove queued offers that this vehicle can no longer accommodate.
      let offers = await routeStorage.getDriverRideOffers(driverId);

      for (const offer of offers) {
        const partySize = Number(offer.passengerCount) ||
          (1 + (Number(offer.additionalPassengers) || 0));

        if (partySize > capacity) {
          await routeStorage.rejectRideOffer(driverId, offer.id);
        }
      }

      offers = offers.filter(offer => {
        const partySize = Number(offer.passengerCount) ||
          (1 + (Number(offer.additionalPassengers) || 0));
        return partySize <= capacity;
      });

      return res.json(offers);
    } catch (e: any) {
      return res.status(500).json({ message: e.message || "Could not fetch ride offers" });
    }
  });

  app.get("/api/rides/driver/:driverId", async (req: Request, res: Response) => {
    const rides = await routeStorage.getRidesByDriver(getRouteParam(req.params.driverId));
    const sanitized = rides.map(r => {
      if (r.review) return { ...r, review: { rating: r.review.rating, createdAt: r.review.createdAt } };
      return r;
    });
    return res.json(sanitized);
  });

  app.get("/api/rides/driver/:driverId/active", async (req: Request, res: Response) => {
    const rides = await routeStorage.getRidesByDriver(getRouteParam(req.params.driverId));
    const active = rides.filter(r => !['completed', 'cancelled'].includes(r.status));
    return res.json(active.length > 0 ? active : null);
  });

  app.get("/api/rides/rider/:riderId/active", async (req: Request, res: Response) => {
    const rides = await routeStorage.getRidesByRider(getRouteParam(req.params.riderId));
    const active = rides.find(r => !['completed', 'cancelled'].includes(r.status));
    if (active) return res.json(active);

      const recentCompleted = rides
      .filter(r => r.status === 'completed' && r.completedAt && !r.review)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())[0];
    if (recentCompleted) {
      const completedAgo = Date.now() - new Date(recentCompleted.completedAt!).getTime();
      if (completedAgo < 60000) {
        return res.json(recentCompleted);
      }
    }

    return res.json(null);
  });

  app.get("/api/rides/:id", async (req: Request, res: Response) => {
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    return res.json(ride);
  });

  app.put("/api/rides/:id/reject", async (req: Request, res: Response) => {
    try {
      const driverId = req.body.driverId;
      if (!driverId) return res.status(400).json({ message: "driverId required" });

      const rejected = await routeStorage.rejectRideOffer(
        driverId,
        getRouteParam(req.params.id)
      );

      if (!rejected) {
        return res.status(409).json({ message: "Offer is no longer available" });
      }

      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message || "Could not reject offer" });
    }
  });

  app.put("/api/rides/:id/accept", async (req: Request, res: Response) => {
    try {
      const { driverId } = req.body;
      if (!driverId) return res.status(400).json({ message: "driverId required" });

      const rideId = getRouteParam(req.params.id);
      const ride = await routeStorage.getRide(rideId);
      if (!ride) return res.status(404).json({ message: "Ride not found" });

      const driver = await routeStorage.getUser(driverId);
      if (!driver) return res.status(404).json({ message: "Driver not found" });

      const result = await routeStorage.acceptRideOffer(
        driverId,
        rideId,
        driver.fullName
      );

      if (result.status !== 'accepted' || !result.ride) {
        const messages = {
          not_available: "Ride is no longer available",
          active_ride: "You already have an active ride",
          offer_missing: "This offer has expired or is no longer available",
          not_driver: "This account is not registered as a driver",
          driver_offline: "Go online before accepting a ride",
          driver_suspended: "Your driver account is suspended",
          capacity_unverified: "Update your vehicle details and passenger capacity before accepting rides",
          capacity_exceeded: "Your vehicle does not have enough passenger seats for this booking",
        };

        return res.status(409).json({
          message: messages[result.status as keyof typeof messages],
          code: result.status,
        });
      }

      await routeStorage.createEvent({
        type: 'ride_accepted',
        rideId: result.ride.id,
        userId: result.ride.riderId,
        data: {
          driverName: driver.fullName,
          vehicleInfo: driver.vehicleInfo,
        },
        read: false,
      });

      return res.json(result.ride);
    } catch (e: any) {
      return res.status(500).json({ message: e.message || "Could not accept ride" });
    }
  });

  app.put("/api/rides/:id/status", async (req: Request, res: Response) => {
    const { status } = req.body as { status: RideStatus };
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    const updates: Partial<typeof ride> = { status };
    if (status === 'arriving') {
      // no extra fields
    } else if (status === 'arrived') {
      updates.arrivedAt = new Date().toISOString();
    } else if (status === 'in_progress') {
      updates.startedAt = new Date().toISOString();
    } else if (status === 'completed') {
      updates.completedAt = new Date().toISOString();
      if (ride.driverId && ride.fare) {
        const driver = await routeStorage.getUser(ride.driverId);
        if (driver) {
          await routeStorage.updateUser(ride.driverId, {
            totalRides: (driver.totalRides || 0) + 1,
            totalEarnings: (driver.totalEarnings || 0) + ride.fare.driverEarnings,
          });
        }
      }
    }

    const updated = await routeStorage.updateRide(getRouteParam(req.params.id), updates);

    const eventTypeMap: Record<string, string> = {
      arriving: 'driver_arriving',
      arrived: 'driver_arrived',
      in_progress: 'ride_started',
      completed: 'ride_completed',
      cancelled: 'ride_cancelled',
    };
    const eventType = eventTypeMap[status];
    if (eventType && ride.riderId) {
      await routeStorage.createEvent({
        type: eventType as any,
        rideId: ride.id,
        userId: ride.riderId,
        data: { status, fare: ride.fare },
        read: false,
      });
    }
    if (eventType && ride.driverId) {
      await routeStorage.createEvent({
        type: eventType as any,
        rideId: ride.id,
        userId: ride.driverId,
        data: { status, fare: ride.fare },
        read: false,
      });
    }

    return res.json(updated);
  });

  app.get("/api/events/:userId", async (req: Request, res: Response) => {
    const events = await routeStorage.getEventsByUser(getRouteParam(req.params.userId));
    return res.json(events);
  });

  app.put("/api/events/:eventId/read", async (req: Request, res: Response) => {
    await routeStorage.markEventRead(getRouteParam(req.params.eventId));
    return res.json({ success: true });
  });

  app.get("/api/admin/stats", async (_req: Request, res: Response) => {
    const allRides = await routeStorage.getAllRides();
    const allUsers = await routeStorage.getAllUsers();
    const drivers = allUsers.filter(u => u.role === 'driver');
    const riders = allUsers.filter(u => u.role === 'rider');
    const activeRides = await routeStorage.getActiveRides();
    const completedRides = allRides.filter(r => r.status === 'completed');
    const cancelledRides = allRides.filter(r => r.status === 'cancelled');
    const suspendedUsers = allUsers.filter(u => u.suspended);

    const totalRevenue = completedRides.reduce((sum, r) => sum + (r.fare?.totalFare || 0), 0);
    const totalDriverEarnings = completedRides.reduce((sum, r) => sum + (r.fare?.driverEarnings || 0), 0);
    const platformRevenue = completedRides.reduce((sum, r) => sum + (r.fare?.platformFee || 0), 0);

    return res.json({
      totalDrivers: drivers.length,
      totalRiders: riders.length,
      onlineDrivers: drivers.filter(d => d.isOnline && !d.suspended).length,
      totalRides: allRides.length,
      activeRides: activeRides.length,
      completedRides: completedRides.length,
      cancelledRides: cancelledRides.length,
      suspendedUsers: suspendedUsers.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalDriverEarnings: Math.round(totalDriverEarnings * 100) / 100,
      platformRevenue: Math.round(platformRevenue * 100) / 100,
    });
  });

  app.get("/api/admin/rides", async (_req: Request, res: Response) => {
    const rides = await routeStorage.getAllRides();
    return res.json(rides);
  });

  app.get("/api/admin/users", async (_req: Request, res: Response) => {
    const allUsers = await routeStorage.getAllUsers();
    const filtered = allUsers.filter(u => u.role !== 'admin').map(u => {
      const { password: _, ...safe } = u;
      return safe;
    });
    return res.json(filtered);
  });

  app.put("/api/admin/users/:id/suspend", async (req: Request, res: Response) => {
    const user = await routeStorage.getUser(getRouteParam(req.params.id));
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role === 'admin') return res.status(403).json({ message: "Cannot suspend admin" });
    const updated = await routeStorage.updateUser(getRouteParam(req.params.id), {
      suspended: !user.suspended,
      isOnline: user.suspended ? user.isOnline : false,
    });
    if (!updated) return res.status(500).json({ message: "Update failed" });
    const { password: _, ...safe } = updated;
    return res.json(safe);
  });

  app.delete("/api/admin/users/:id", async (req: Request, res: Response) => {
    const user = await routeStorage.getUser(getRouteParam(req.params.id));
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role === 'admin') return res.status(403).json({ message: "Cannot remove admin" });
    await routeStorage.deleteUser(getRouteParam(req.params.id));
    return res.json({ success: true });
  });

  app.put("/api/admin/rides/:id/cancel", async (req: Request, res: Response) => {
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (['completed', 'cancelled'].includes(ride.status)) {
      return res.status(400).json({ message: "Ride already " + ride.status });
    }
    const updated = await routeStorage.updateRide(getRouteParam(req.params.id), {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    return res.json(updated);
  });

  app.get("/api/admin/config", async (_req: Request, res: Response) => {
    const config = await routeStorage.getConfig();
    return res.json(config);
  });

  app.put("/api/admin/config", async (req: Request, res: Response) => {
    const config = await routeStorage.updateConfig(req.body);
    return res.json(config);
  });

  app.put("/api/rides/:id/review", async (req: Request, res: Response) => {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (ride.status !== 'completed') return res.status(400).json({ message: "Can only review completed rides" });
    if (ride.review) return res.status(400).json({ message: "Ride already reviewed" });

    const review = {
      rating: Math.round(rating),
      comment: comment?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    const updated = await routeStorage.updateRide(getRouteParam(req.params.id), { review });

    if (ride.driverId) {
      const driverRides = await routeStorage.getRidesByDriver(ride.driverId);
      const reviewedRides = driverRides.filter(r => r.review);
      const totalRating = reviewedRides.reduce((sum, r) => sum + (r.review?.rating || 0), 0) + rating;
      const avgRating = totalRating / (reviewedRides.length + 1);
      await routeStorage.updateUser(ride.driverId, { rating: Math.round(avgRating * 10) / 10 });
    }

    return res.json(updated);
  });

  app.get("/api/rides/rider/:riderId/recent-completed", async (req: Request, res: Response) => {
    const rides = await routeStorage.getRidesByRider(getRouteParam(req.params.riderId));
    const completed = rides.find(r => r.status === 'completed' && !r.review);
    return res.json(completed || null);
  });

  app.get("/api/fare/estimate", async (req: Request, res: Response) => {
    const coordinateParams = ['pLat', 'pLng', 'dLat', 'dLng'] as const;
    const coordinates: number[] = [];

    for (const key of coordinateParams) {
      const value = req.query[key];

      if (typeof value !== 'string' || value.trim() === '') {
        return res.status(400).json({ message: `Valid ${key} coordinate required` });
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return res.status(400).json({ message: `Invalid ${key} coordinate` });
      }

      coordinates.push(parsed);
    }

    const [pLat, pLng, dLat, dLng] = coordinates;

    if (
      pLat < -90 || pLat > 90 ||
      dLat < -90 || dLat > 90 ||
      pLng < -180 || pLng > 180 ||
      dLng < -180 || dLng > 180
    ) {
      return res.status(400).json({ message: "Coordinates out of range" });
    }

    const passengerParam = req.query.additionalPassengers;
    let additionalPassengers = 0;

    if (passengerParam !== undefined) {
      if (
        typeof passengerParam !== 'string' ||
        !/^[0-7]$/.test(passengerParam)
      ) {
        return res.status(400).json({ message: "Additional passengers must be an integer from 0 to 7" });
      }

      additionalPassengers = Number(passengerParam);
    }

    const requestedRideType = req.query.rideType;
    if (
      requestedRideType !== undefined &&
      requestedRideType !== 'private' &&
      requestedRideType !== 'shared'
    ) {
      return res.status(400).json({ message: "Invalid ride type" });
    }

    const rideType = requestedRideType === 'shared' ? 'shared' : 'private';
    const distance = calculateDistance(pLat, pLng, dLat, dLng);
    const duration = Math.round(distance * (3 / 1.609344));
    const fare = await routeStorage.calculateFareForDistance(
      distance, additionalPassengers, rideType
    );

    return res.json({
      distance: Math.round(distance * 10) / 10,
      duration,
      ...fare,
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}
