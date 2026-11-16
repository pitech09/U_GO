import { calculateDistance } from "../shared/distance";
import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import { storage, type IStorage } from "./storage";
import { registerSchema, loginSchema, requestRideSchema, updateLocationSchema, updateVehicleSchema, vehiclePhotosSchema, driverKycSchema } from "@shared/schema";
import type { RideStatus } from "@shared/schema";
import { randomUUID } from "node:crypto";
import { initiateMobileMoneyPayment, parseProviderWebhook, queryMpesaTransaction, reverseMpesaTransaction, verifyProviderWebhook, type MobileMoneyProvider } from "./payments";
import { publishRealtimeEvent } from "./realtime";
import { hashPassword, signAccessToken, verifyPassword } from "./auth";
import { roundCashFare } from "../shared/fare";

function getRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function authenticatedDriverId(res: Response): string | null {
  return res.locals.auth?.role === 'driver' ? res.locals.auth.sub : null;
}

function authenticatedUserId(res: Response): string | null {
  return res.locals.auth?.sub || null;
}

function isAdmin(res: Response): boolean {
  return res.locals.auth?.role === 'admin';
}

function publicUser(user: any) {
  const { password: _, ...safe } = user;
  if (safe.kyc) {
    safe.kyc = {
      status: safe.kyc.status,
      submittedAt: safe.kyc.submittedAt,
      reviewedAt: safe.kyc.reviewedAt,
      rejectionReason: safe.kyc.rejectionReason,
    };
  }
  return safe;
}

const GEOAPIFY_TIMEOUT_MS = 8_000;

async function fetchGeoapify(url: string): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOAPIFY_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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

  const response = await fetchGeoapify(url.toString());

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

async function routeGeoapify(waypoints: Array<{ lat: number; lng: number }>): Promise<Array<{ latitude: number; longitude: number }>> {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEOAPIFY_API_KEY is not configured");
  }

  const url = new URL("https://api.geoapify.com/v1/routing");
  url.searchParams.set(
    "waypoints",
    waypoints.map((point) => `${point.lat},${point.lng}`).join("|")
  );
  url.searchParams.set("mode", "drive");
  url.searchParams.set("apiKey", apiKey);

  const response = await fetchGeoapify(url.toString());

  if (!response.ok) {
    throw new Error(`Geoapify routing returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const geometry = data.features?.[0]?.geometry;
  const coordinates = geometry?.type === "LineString"
    ? geometry.coordinates
    : geometry?.type === "MultiLineString"
      ? geometry.coordinates.flat()
      : [];

  return coordinates
    .filter((point: unknown): point is [number, number] =>
      Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(point[0]) && Number.isFinite(point[1])
    )
    .map(([longitude, latitude]: [number, number]) => ({ latitude, longitude }));
}

async function estimateGeoapifyTravelSeconds(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<number> {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) throw new Error("GEOAPIFY_API_KEY is not configured");

  const url = new URL("https://api.geoapify.com/v1/routing");
  url.searchParams.set("waypoints", `${from.lat},${from.lng}|${to.lat},${to.lng}`);
  url.searchParams.set("mode", "drive");
  url.searchParams.set("apiKey", apiKey);
  const response = await fetchGeoapify(url.toString());
  if (!response.ok) throw new Error(`Geoapify routing returned HTTP ${response.status}`);
  const data = await response.json();
  const seconds = Number(data.features?.[0]?.properties?.time);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Routing duration unavailable");
  return Math.round(seconds);
}

export async function registerRoutes(app: Express, routeStorage: IStorage = storage): Promise<Server> {

  app.get('/api/health', async (_req: Request, res: Response) => {
    const redisHealthy = await routeStorage.healthCheck();
    return res.status(redisHealthy ? 200 : 503).json({
      status: redisHealthy ? 'ok' : 'degraded',
      redis: redisHealthy ? 'ok' : 'unavailable',
      timestamp: new Date().toISOString(),
    });
  });

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

  app.post("/api/routes/route", async (req: Request, res: Response) => {
    const waypoints = req.body?.waypoints;

    if (!Array.isArray(waypoints) || waypoints.length < 2 || waypoints.length > 25) {
      return res.status(400).json({ message: "Between 2 and 25 route waypoints are required." });
    }

    const parsedWaypoints = waypoints.map((point: any) => ({
      lat: Number(point?.lat),
      lng: Number(point?.lng),
    }));

    if (parsedWaypoints.some(({ lat, lng }) =>
      !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180
    )) {
      return res.status(400).json({ message: "Route waypoints must contain valid coordinates." });
    }

    try {
      const coordinates = await routeGeoapify(parsedWaypoints);
      if (coordinates.length < 2) {
        return res.status(502).json({ message: "No drivable route was found." });
      }
      return res.json({ coordinates });
    } catch (error) {
      console.error("Road route lookup failed:", error);
      // Keep the rider/driver map useful if the external routing provider is
      // unavailable. The client can render this degraded route immediately,
      // while the next route refresh can try Geoapify again.
      return res.json({
        coordinates: parsedWaypoints.map(({ lat, lng }) => ({
          latitude: lat,
          longitude: lng,
        })),
        fallback: true,
        message: "Live road routing is temporarily unavailable; showing a direct route.",
      });
    }
  });

  app.post("/api/routes/eta", async (req: Request, res: Response) => {
    const from = { lat: Number(req.body?.from?.lat), lng: Number(req.body?.from?.lng) };
    const to = { lat: Number(req.body?.to?.lat), lng: Number(req.body?.to?.lng) };
    if (![from.lat, from.lng, to.lat, to.lng].every(Number.isFinite)) {
      return res.status(400).json({ message: "Valid origin and destination coordinates are required." });
    }
    try {
      const travelSeconds = await estimateGeoapifyTravelSeconds(from, to);
      return res.json({ travelSeconds, calculatedAt: new Date().toISOString() });
    } catch (error) {
      console.error("Scheduled pickup ETA failed:", error);
      return res.status(503).json({ message: "Road ETA is temporarily unavailable." });
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
        password: await hashPassword(parsed.password),
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
      return res.json({ user: safe, accessToken: signAccessToken(user) });
    } catch (e: any) {
      return res.status(400).json({ message: e.message || "Invalid data" });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.parse(req.body);
      const user = await routeStorage.getUserByUsername(parsed.username);
      if (!user || !(await verifyPassword(parsed.password, user.password))) {
        return res.status(401).json({
          message: "The username or password is incorrect. Please check your details and try again.",
        });
      }
      if (user.active === false || user.suspended) {
        return res.status(403).json({ message: "This account is currently inactive. Please contact U-GO support." });
      }
      if (!user.password.startsWith('scrypt$')) {
        await routeStorage.updateUser(user.id, { password: await hashPassword(parsed.password) });
      }
      const { password: _, ...safe } = user;
      return res.json({ user: safe, accessToken: signAccessToken(user) });
    } catch (e: any) {
      return res.status(400).json({ message: e.message || "Invalid data" });
    }
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    const userId = res.locals.auth?.sub;
    const user = userId ? await routeStorage.getUser(userId) : undefined;
    if (!user) return res.status(401).json({ message: "Account no longer exists" });
    return res.json(publicUser(user));
  });

  app.get("/api/user/:id", async (req: Request, res: Response) => {
    const userId = getRouteParam(req.params.id);
    const user = await routeStorage.getUser(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    const canViewPublicDriver = res.locals.auth?.role === 'rider' && user.role === 'driver';
    if (res.locals.auth && !isAdmin(res) && authenticatedUserId(res) !== userId && !canViewPublicDriver) {
      return res.status(403).json({ message: "You can only view your own account" });
    }
    return res.json(publicUser(user));
  });

  app.put("/api/user/:id/vehicle", async (req: Request, res: Response) => {
    try {
      const userId = getRouteParam(req.params.id);
      if (res.locals.auth && authenticatedUserId(res) !== userId && !isAdmin(res)) {
        return res.status(403).json({ message: "You can only update your own vehicle" });
      }
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

  app.put("/api/drivers/me/vehicle-photos", async (_req: Request, res: Response) => {
    const driverId = authenticatedDriverId(res);
    if (!driverId) return res.status(403).json({ message: "Only authenticated drivers can upload vehicle photos." });
    try {
      const parsed = vehiclePhotosSchema.parse(_req.body);
      const updated = await routeStorage.updateUser(driverId, { vehiclePhotos: parsed.photos });
      if (!updated) return res.status(404).json({ message: "Driver account not found." });
      return res.json({ vehiclePhotos: updated.vehiclePhotos ?? [] });
    } catch (e: any) {
      return res.status(400).json({ message: e.message || "Invalid vehicle photos." });
    }
  });

  app.put("/api/drivers/me/kyc", async (req: Request, res: Response) => {
    const driverId = authenticatedDriverId(res);
    if (!driverId) return res.status(403).json({ message: "Only authenticated drivers can submit KYC." });
    try {
      const parsed = driverKycSchema.parse(req.body);
      const updated = await routeStorage.updateUser(driverId, {
        kyc: {
          ...parsed,
          status: 'pending',
          submittedAt: new Date().toISOString(),
          reviewedAt: undefined,
          reviewedBy: undefined,
          rejectionReason: undefined,
        },
      });
      if (!updated) return res.status(404).json({ message: "Driver account not found." });
      return res.json({ kyc: { status: updated.kyc?.status, submittedAt: updated.kyc?.submittedAt } });
    } catch (e: any) {
      return res.status(400).json({ message: e.message || "Invalid KYC documents." });
    }
  });

  app.put("/api/user/:id/location", async (req: Request, res: Response) => {
    try {
      const userId = getRouteParam(req.params.id);
      if (res.locals.auth && authenticatedUserId(res) !== userId) {
        return res.status(403).json({ message: "You can only update your own location" });
      }
      const parsed = updateLocationSchema.parse(req.body);
      const user = await routeStorage.updateUser(userId, {
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
      if (res.locals.auth && authenticatedUserId(res) !== userId && !isAdmin(res)) {
        return res.status(403).json({ message: "You can only update your own driver status" });
      }
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
      if (res.locals.auth && (res.locals.auth.role !== 'rider' || authenticatedUserId(res) !== riderId)) {
        return res.status(403).json({ message: "Only the authenticated rider can create this ride" });
      }

      const rider = await routeStorage.getUser(riderId);
      if (!rider) return res.status(404).json({ message: "Rider not found" });

      const ride = await routeStorage.createRide({
        riderId,
        status: parsed.scheduledAt ? 'scheduled' : 'requested',
        pickup: parsed.pickup,
        dropoff: parsed.dropoff,
        rideType: parsed.serviceType === 'parcel' ? 'shared' : parsed.rideType,
        serviceType: parsed.serviceType,
        additionalPassengers: parsed.additionalPassengers,
        passengerCount: parsed.passengerCount,
        parcel: parsed.parcel,
        scheduledAt: parsed.scheduledAt,
        riderName: rider.fullName,
      });

      await routeStorage.createEvent({
        type: 'ride_requested',
        rideId: ride.id,
        userId: riderId,
        data: { pickup: ride.pickup, dropoff: ride.dropoff, fare: ride.fare },
        read: false,
      });

      // Scheduled rides stay queued until their pickup time. Immediate rides
      // enter normal dispatch immediately.
      if (ride.status === 'requested') await routeStorage.startRideDispatch(ride.id);

      return res.json(ride);
    } catch (e: any) {
      return res.status(400).json({ message: e.message });
    }
  });

  app.put("/api/rides/:id/payment", async (req: Request, res: Response) => {
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (res.locals.auth && ride.riderId !== authenticatedUserId(res)) {
      return res.status(403).json({ message: "Only the rider can submit this payment" });
    }
    if (ride.status !== 'in_progress' && !ride.cancellationPaymentRequired) {
      return res.status(409).json({ message: "Payment can be initiated after the ride has started or after an assigned ride is cancelled" });
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

    const exactFare = Number(ride.fare?.totalFare);
    if (!Number.isFinite(exactFare) || exactFare <= 0) {
      return res.status(400).json({ message: "This ride does not have a payable fare" });
    }

    const updated = await routeStorage.updateRide(ride.id, {
      payment: {
        method,
        status: method === 'cash' ? 'pending_cash' : 'pending_verification',
        amount: method === 'cash'
          ? roundCashFare(exactFare)
          : exactFare,
        transactionReference: reference || undefined,
        proofImage,
        submittedAt: new Date().toISOString(),
      },
    });
    if (method === 'cash') await routeStorage.postRideFinancials(updated || ride, authenticatedUserId(res) || undefined);

    return res.json(updated);
  });

  app.post("/api/rides/:id/payment/initiate", async (req: Request, res: Response) => {
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (res.locals.auth && ride.riderId !== authenticatedUserId(res)) {
      return res.status(403).json({ message: "Only the rider can initiate this payment" });
    }
    if (ride.status !== 'in_progress') {
      return res.status(409).json({ message: "Payment can be initiated after the ride has started" });
    }

    const provider = req.body.provider as MobileMoneyProvider;
    if (provider !== 'mpesa' && provider !== 'ecocash') {
      return res.status(400).json({ message: "Choose mpesa or ecocash" });
    }

    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const amount = Number(ride.fare?.totalFare);
    if (!phone || !/^\+?[0-9][0-9\s-]{6,18}$/.test(phone)) {
      return res.status(400).json({ message: "A valid mobile-money phone number is required" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "This ride does not have a payable fare" });
    }

    const merchantReference = `ride:${ride.id}:${randomUUID()}`;
    const forwardedProto = req.header('x-forwarded-proto') || req.protocol;
    const forwardedHost = req.header('x-forwarded-host') || req.get('host');
    const callbackUrl = process.env.PAYMENTS_CALLBACK_BASE_URL
      ? `${process.env.PAYMENTS_CALLBACK_BASE_URL.replace(/\/$/, '')}/api/payments/webhooks/${provider}`
      : `${forwardedProto}://${forwardedHost}/api/payments/webhooks/${provider}`;

    try {
      const result = await initiateMobileMoneyPayment(provider, {
        amount: Math.round(amount * 100) / 100,
        currency: 'LSL',
        phone,
        merchantReference,
        callbackUrl,
      });

      const updated = await routeStorage.updateRide(ride.id, {
        payment: {
          method: provider,
          status: result.status === 'paid' ? 'paid' : result.status === 'failed' ? 'failed' : 'pending_provider',
          providerTransactionId: result.providerTransactionId,
          providerConversationId: result.providerConversationId,
          thirdPartyConversationId: result.thirdPartyConversationId,
          phone,
          amount,
          transactionReference: result.providerTransactionId,
          submittedAt: new Date().toISOString(),
          ...(result.status === 'paid' ? { verifiedAt: new Date().toISOString() } : {}),
        },
      });

      const eventType = result.status === 'paid' ? 'payment_paid' : result.status === 'failed' ? 'payment_failed' : 'payment_pending';
      const event = await routeStorage.createEvent({
        type: eventType,
        rideId: ride.id,
        userId: ride.riderId,
        data: { provider, transactionId: result.providerTransactionId },
        read: false,
      });
      publishRealtimeEvent(ride.riderId, { type: event.type, data: event.data });

      return res.status(202).json({
        ride: updated,
        provider,
        providerTransactionId: result.providerTransactionId,
        status: result.status,
        message: result.message,
      });
    } catch (error: any) {
      return res.status(error?.name === 'ProviderNotConfiguredError' ? 503 : 502).json({
        message: error?.message || "Mobile-money payment could not be initiated",
      });
    }
  });

  app.get("/api/rides/:id/payment/status", async (req: Request, res: Response) => {
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (res.locals.auth && (ride.riderId !== authenticatedUserId(res) || req.query.riderId !== authenticatedUserId(res))) {
      return res.status(403).json({ message: "Only the rider can view this payment" });
    }
    if (ride.payment?.method === 'mpesa' && ride.payment.status === 'pending_provider') {
      try {
        const result = await queryMpesaTransaction({
          transactionId: ride.payment.providerTransactionId,
          conversationId: ride.payment.providerConversationId,
          thirdPartyConversationId: ride.payment.thirdPartyConversationId,
        });
        const status = result.status === 'paid' ? 'paid' : result.status === 'failed' ? 'failed' : 'pending_provider';
        const updated = await routeStorage.updateRide(ride.id, {
          payment: {
            ...ride.payment,
            status,
            providerTransactionId: result.providerTransactionId || ride.payment.providerTransactionId,
            providerConversationId: result.providerConversationId || ride.payment.providerConversationId,
            thirdPartyConversationId: result.thirdPartyConversationId || ride.payment.thirdPartyConversationId,
            ...(status === 'paid' ? { verifiedAt: new Date().toISOString() } : {}),
          },
        });
        return res.json({ payment: updated?.payment || null });
      } catch {
        // Return the locally known state if the provider is temporarily unavailable.
      }
    }
    return res.json({ payment: ride.payment || null });
  });

  app.post("/api/admin/rides/:id/payment/reversal", async (req: Request, res: Response) => {
    const admin = await routeStorage.getUser(res.locals.auth?.sub);
    if (!admin || admin.role !== 'admin') {
      return res.status(403).json({ message: "Admin access required" });
    }

    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride?.payment) return res.status(404).json({ message: "Payment not found" });
    if (ride.payment.method !== 'mpesa' || ride.payment.status !== 'paid') {
      return res.status(409).json({ message: "Only paid M-Pesa transactions can be reversed" });
    }
    if (!ride.payment.providerTransactionId || !ride.payment.thirdPartyConversationId) {
      return res.status(409).json({ message: "M-Pesa transaction references are incomplete" });
    }

    try {
      const result = await reverseMpesaTransaction({
        transactionId: ride.payment.providerTransactionId,
        amount: req.body.amount ? Number(req.body.amount) : undefined,
        thirdPartyConversationId: ride.payment.thirdPartyConversationId,
      });
      const updated = await routeStorage.updateRide(ride.id, {
        payment: {
          ...ride.payment,
          status: 'rejected',
          reversedAt: new Date().toISOString(),
          reversalTransactionId: result.transactionId,
          verifiedBy: admin.id,
        },
      });
      return res.json(updated);
    } catch (error: any) {
      return res.status(502).json({ message: error?.message || "M-Pesa reversal failed" });
    }
  });

  app.post("/api/payments/webhooks/:provider", async (req: Request, res: Response) => {
    const provider = getRouteParam(req.params.provider) as MobileMoneyProvider;
    if (provider !== 'mpesa' && provider !== 'ecocash') {
      return res.status(404).json({ message: "Unknown payment provider" });
    }
    if (!verifyProviderWebhook(provider, req.rawBody, req.header('x-provider-signature'))) {
      return res.status(401).json({ message: "Invalid payment webhook signature" });
    }

    const webhook = parseProviderWebhook(req.body);
    if (!webhook.providerTransactionId) {
      return res.status(400).json({ message: "Payment transaction ID is required" });
    }

    const rides = await routeStorage.getAllRides();
    const ride = rides.find((candidate) =>
      candidate.payment?.providerTransactionId === webhook.providerTransactionId ||
      (webhook.providerConversationId && candidate.payment?.providerConversationId === webhook.providerConversationId) ||
      (webhook.thirdPartyConversationId && candidate.payment?.thirdPartyConversationId === webhook.thirdPartyConversationId) ||
      (webhook.merchantReference && webhook.merchantReference.startsWith(`ride:${candidate.id}:`))
    );
    if (!ride?.payment) return res.status(404).json({ message: "Payment transaction not found" });

    const status = webhook.status === 'paid' ? 'paid' : webhook.status === 'failed' ? 'failed' : 'pending_provider';
    const updated = await routeStorage.updateRide(ride.id, {
      payment: {
        ...ride.payment,
        status,
        providerTransactionId: webhook.providerTransactionId || ride.payment.providerTransactionId,
        providerConversationId: webhook.providerConversationId || ride.payment.providerConversationId,
        thirdPartyConversationId: webhook.thirdPartyConversationId || ride.payment.thirdPartyConversationId,
        transactionReference: webhook.transactionReference || ride.payment.transactionReference,
        ...(status === 'paid' ? { verifiedAt: new Date().toISOString() } : {}),
      },
    });
    if (status === 'paid') await routeStorage.postRideFinancials(updated || ride);

    const eventType = status === 'paid' ? 'payment_paid' : status === 'failed' ? 'payment_failed' : 'payment_pending';
    const event = await routeStorage.createEvent({
      type: eventType,
      rideId: ride.id,
      userId: ride.riderId,
      data: { provider, transactionId: webhook.providerTransactionId, status },
      read: false,
    });
    publishRealtimeEvent(ride.riderId, { type: event.type, data: event.data });

    if (provider === 'mpesa') {
      return res.json({
        output_OriginalConversationID: webhook.providerConversationId || ride.payment.providerConversationId,
        output_ResponseCode: 'INS-GAR-0',
        output_ResponseDesc: 'Successfully Accepted Result',
        output_ThirdPartyConversationID: webhook.thirdPartyConversationId || ride.payment.thirdPartyConversationId,
      });
    }

    return res.json({ received: true, ride: updated });
  });

  app.put("/api/admin/rides/:id/payment", async (req: Request, res: Response) => {
    const { status } = req.body as { status?: string };
    const admin = await routeStorage.getUser(res.locals.auth?.sub);
    if (!admin) return res.status(403).json({ message: "Admin access required" });

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
    if (status === 'paid') await routeStorage.postRideFinancials(updated || ride, admin.id);

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
      if (res.locals.auth && authenticatedUserId(res) !== riderId) return res.status(403).json({ message: "Access denied" });
      const offers = await routeStorage.getRideOffersForRider(riderId);
      return res.json(offers);
    } catch (e: any) {
      return res.status(500).json({ message: e.message || "Could not fetch ride offers" });
    }
  });

  app.get("/api/rides/rider/:riderId", async (req: Request, res: Response) => {
    if (res.locals.auth && authenticatedUserId(res) !== getRouteParam(req.params.riderId)) return res.status(403).json({ message: "Access denied" });
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
      if (res.locals.auth && (res.locals.auth.role !== 'driver' || authenticatedUserId(res) !== driverId)) return res.status(403).json({ message: "Access denied" });
      const driver = await routeStorage.getUser(driverId);

      if (!driver) return res.status(404).json({ message: "Driver not found" });

      const capacity = Number(driver.vehicleInfo?.seatingCapacity);
      if (
        driver.role !== "driver" ||
        driver.suspended ||
        !Number.isInteger(capacity) ||
        capacity < 1 ||
        capacity > 8
      ) {
        return res.json([]);
      }

      const driverRides = await routeStorage.getRidesByDriver(driverId);
      const activeRide = driverRides.find(
        ride => !['completed', 'cancelled', 'scheduled'].includes(ride.status)
      );

      // An active PRIVATE ride prevents new offers from being created for
      // this driver, but must not hide offers already persisted in Redis.
      // Those offers remain visible and are rejected by the atomic acceptance
      // check until the driver's active ride is complete.
      const hasActivePrivateRide = activeRide?.rideType === 'private';

      // Reconcile pending requests during the driver's poll. This recovers
      // offers if the dispatch scheduler was restarted or missed a tick.
      const config = await routeStorage.getConfig();
      // Clean expired queue entries before trying to re-advertise pending
      // rides. Explicit rejection remains permanent; timeout does not.
      await routeStorage.getDriverRideOffers(driverId);
      const pendingRides = driver.isOnline && !hasActivePrivateRide
        ? (await routeStorage.getAllRides()).filter(ride => ride.status === 'requested')
        : [];
      for (const ride of pendingRides) {
        const requiredCapacity = ride.serviceType === 'parcel'
          ? Math.max(1, Math.round(Number(ride.fare?.parcelMultiplier) || 1))
          : Number(ride.passengerCount) || (1 + (Number(ride.additionalPassengers) || 0));
        if (requiredCapacity > capacity || !driver.currentLocation) continue;
        const distance = calculateDistance(
          ride.pickup.lat,
          ride.pickup.lng,
          driver.currentLocation.lat,
          driver.currentLocation.lng,
        );
        const dispatchRadius = ride.scheduledAt
          ? config.dispatchMaximumRadiusKm
          : config.dispatchInitialRadiusKm;
        if (distance > dispatchRadius) continue;
        const created = await routeStorage.createRideOffer(
          driverId,
          ride.id,
          config.dispatchOfferWindowSeconds,
        );
        if (created) {
          const event = await routeStorage.createEvent({
            type: 'ride_requested',
            rideId: ride.id,
            userId: driverId,
            data: {
              pickup: ride.pickup,
              dropoff: ride.dropoff,
              fare: ride.fare,
              riderName: ride.riderName,
              serviceType: ride.serviceType,
              scheduledAt: ride.scheduledAt,
            },
            read: false,
          });
          publishRealtimeEvent(driverId, { type: event.type, data: event.data });
        }
      }

      // Remove queued offers that this vehicle can no longer accommodate.
      let offers = await routeStorage.getDriverRideOffers(driverId);

      console.info('[RideNotification]', JSON.stringify({
        stage: 'offers_returned',
        driverId,
        offerCount: offers.length,
        offerIds: offers.map(offer => offer.id),
        polledAt: Date.now(),
      }));

      for (const offer of offers) {
        const partySize = offer.serviceType === 'parcel'
          ? Math.max(1, Math.round(Number(offer.fare?.parcelMultiplier) || 1))
          : Number(offer.passengerCount) || (1 + (Number(offer.additionalPassengers) || 0));

        if (partySize > capacity) {
          await routeStorage.rejectRideOffer(driverId, offer.id);
        }
      }

      offers = offers.filter(offer => {
        const partySize = offer.serviceType === 'parcel'
          ? Math.max(1, Math.round(Number(offer.fare?.parcelMultiplier) || 1))
          : Number(offer.passengerCount) || (1 + (Number(offer.additionalPassengers) || 0));
        return partySize <= capacity;
      });

      return res.json(offers);
    } catch (e: any) {
      return res.status(500).json({ message: e.message || "Could not fetch ride offers" });
    }
  });

  app.get("/api/rides/driver/:driverId", async (req: Request, res: Response) => {
    if (res.locals.auth && (res.locals.auth.role !== 'driver' || authenticatedUserId(res) !== getRouteParam(req.params.driverId))) return res.status(403).json({ message: "Access denied" });
    const rides = await routeStorage.getRidesByDriver(getRouteParam(req.params.driverId));
    const sanitized = rides.map(r => {
      if (r.review) return { ...r, review: { rating: r.review.rating, comment: r.review.comment, createdAt: r.review.createdAt } };
      return r;
    });
    return res.json(sanitized);
  });

  app.get("/api/rides/driver/:driverId/active", async (req: Request, res: Response) => {
    if (res.locals.auth && (res.locals.auth.role !== 'driver' || authenticatedUserId(res) !== getRouteParam(req.params.driverId))) return res.status(403).json({ message: "Access denied" });
    const rides = await routeStorage.getRidesByDriver(getRouteParam(req.params.driverId));
    const active = rides.filter(r => !['completed', 'cancelled', 'scheduled'].includes(r.status));
    return res.json(active.length > 0 ? active : null);
  });

  app.get("/api/rides/driver/:driverId/scheduled", async (req: Request, res: Response) => {
    const driverId = getRouteParam(req.params.driverId);
    if (res.locals.auth && (res.locals.auth.role !== 'driver' || authenticatedUserId(res) !== driverId)) return res.status(403).json({ message: "Access denied" });
    const driver = await routeStorage.getUser(driverId);
    if (!driver || driver.role !== 'driver') return res.status(404).json({ message: 'Driver not found' });
    const capacity = Number(driver.vehicleInfo?.seatingCapacity);
    const driverRides = await routeStorage.getRidesByDriver(driverId);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
      return res.json(driverRides.filter(ride => ride.status === 'scheduled' && ride.scheduledAt));
    }
    const config = await routeStorage.getConfig();
    // Expire old scheduled offers before creating the next polling round so
    // a missed offer can be advertised again immediately.
    await routeStorage.getDriverRideOffers(driverId);
    const queued = driver.isOnline
      ? (await routeStorage.getAllRides()).filter(ride => ride.status === 'scheduled' && ride.scheduledAt && !ride.driverId)
      : [];
    for (const ride of queued) {
      const requiredCapacity = ride.serviceType === 'parcel'
        ? Math.max(1, Math.round(Number(ride.fare?.parcelMultiplier) || 1))
        : Number(ride.passengerCount) || (1 + (Number(ride.additionalPassengers) || 0));
      const withinDispatchRadius = !driver.currentLocation || calculateDistance(
        ride.pickup.lat,
        ride.pickup.lng,
        driver.currentLocation.lat,
        driver.currentLocation.lng,
      ) <= config.dispatchMaximumRadiusKm;
      if (requiredCapacity <= capacity && withinDispatchRadius) {
        await routeStorage.createRideOffer(driverId, ride.id, config.dispatchOfferWindowSeconds);
      }
    }
    const assigned = await routeStorage.getRidesByDriver(driverId);
    const offers = await routeStorage.getDriverRideOffers(driverId);
    return res.json([...assigned.filter(ride => ride.status === 'scheduled' && ride.scheduledAt), ...offers.filter(ride => ride.status === 'scheduled' && ride.scheduledAt)]
      .filter((ride, index, all) => all.findIndex(item => item.id === ride.id) === index)
      .sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()));
  });

  app.get("/api/rides/rider/:riderId/active", async (req: Request, res: Response) => {
    if (res.locals.auth && (res.locals.auth.role !== 'rider' || authenticatedUserId(res) !== getRouteParam(req.params.riderId))) return res.status(403).json({ message: "Access denied" });
    const rides = await routeStorage.getRidesByRider(getRouteParam(req.params.riderId));
    const active = rides.find(r => !['completed', 'cancelled', 'scheduled'].includes(r.status));
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
    if (res.locals.auth && !isAdmin(res) && ride.riderId !== authenticatedUserId(res) && ride.driverId !== authenticatedUserId(res)) {
      return res.status(403).json({ message: "Access denied" });
    }
    return res.json(ride);
  });

  app.put("/api/rides/:id/reject", async (req: Request, res: Response) => {
    try {
      const driverId = req.body.driverId;
      if (!driverId) return res.status(400).json({ message: "driverId required" });
      if (res.locals.auth && (res.locals.auth.role !== 'driver' || authenticatedUserId(res) !== driverId)) return res.status(403).json({ message: "Only the authenticated driver can reject this offer" });

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
      if (res.locals.auth && (res.locals.auth.role !== 'driver' || authenticatedUserId(res) !== driverId)) return res.status(403).json({ message: "Only the authenticated driver can accept this offer" });

      const rideId = getRouteParam(req.params.id);
      const ride = await routeStorage.getRide(rideId);
      if (!ride) return res.status(404).json({ message: "Ride not found" });

      const driver = await routeStorage.getUser(driverId);
      if (!driver) return res.status(404).json({ message: "Driver not found" });

      if (ride.scheduledAt) {
        const scheduledStart = new Date(ride.scheduledAt).getTime();
        const scheduledDuration = Math.max(30, Number(ride.duration) || 30) * 60 * 1000;
        const scheduledEnd = scheduledStart + scheduledDuration;
        const existingScheduled = (await routeStorage.getRidesByDriver(driverId)).filter(existing =>
          existing.id !== ride.id &&
          existing.scheduledAt &&
          !['completed', 'cancelled', 'no_drivers_available'].includes(existing.status)
        );
        const overlaps = existingScheduled.some(existing => {
          const existingStart = new Date(existing.scheduledAt!).getTime();
          const existingEnd = existingStart + Math.max(30, Number(existing.duration) || 30) * 60 * 1000;
          return scheduledStart < existingEnd && existingStart < scheduledEnd;
        });
        if (overlaps) {
          return res.status(409).json({ message: "You are not available for this scheduled pickup time." });
        }
      }

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

  app.put("/api/rides/:id/release-scheduled", async (req: Request, res: Response) => {
    const driverId = authenticatedDriverId(res);
    if (!driverId || (req.body.driverId && req.body.driverId !== driverId)) {
      return res.status(403).json({ message: "Only the assigned driver can release this scheduled ride" });
    }

    const rideId = getRouteParam(req.params.id);
    const result = await routeStorage.releaseScheduledRide(driverId, rideId);
    if (result.status !== 'released' || !result.ride) {
      return res.status(result.status === 'not_owner' ? 403 : 409).json({
        message: result.status === 'not_owner'
          ? "You are not assigned to this scheduled ride"
          : "This scheduled ride cannot be released",
      });
    }

    await routeStorage.createEvent({
      type: 'ride_requested',
      rideId: result.ride.id,
      userId: result.ride.riderId,
      data: { status: 'replacement_driver_required', scheduledAt: result.ride.scheduledAt },
      read: false,
    });
    return res.json(result.ride);
  });

  app.put("/api/rides/:id/status", async (req: Request, res: Response) => {
    const { status } = req.body as { status: RideStatus };
    const ride = await routeStorage.getRide(getRouteParam(req.params.id));
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    if (res.locals.auth) {
      if (status === 'cancelled' && (res.locals.auth.role !== 'rider' || ride.riderId !== authenticatedUserId(res))) {
        return res.status(403).json({ message: "Only the rider can cancel this ride" });
      }
      if (status !== 'cancelled' && (res.locals.auth.role !== 'driver' || ride.driverId !== authenticatedUserId(res))) {
        return res.status(403).json({ message: "Only the assigned driver can update this ride" });
      }
    }

    if (status === 'cancelled') {
      const riderId = typeof req.body.riderId === 'string' ? req.body.riderId : undefined;
      if (riderId && riderId !== ride.riderId) {
        return res.status(403).json({ message: "Only the rider can cancel this ride" });
      }
      if (['completed', 'cancelled'].includes(ride.status)) {
        return res.status(409).json({ message: "Ride is already " + ride.status });
      }
    }

    const assignedBeforeCancellation = status === 'cancelled' && Boolean(ride.driverId);
    const updates: Partial<typeof ride> = {
      status,
      ...(assignedBeforeCancellation ? { cancellationPaymentRequired: true } : {}),
    };
    if (status === 'arriving') {
      // no extra fields
    } else if (status === 'arrived') {
      updates.arrivedAt = new Date().toISOString();
    } else if (status === 'in_progress') {
      updates.startedAt = new Date().toISOString();
    } else if (status === 'completed') {
      updates.completedAt = new Date().toISOString();
      if (ride.status !== 'completed' && ride.driverId) {
        const driver = await routeStorage.getUser(ride.driverId);
        if (driver) {
          await routeStorage.updateUser(ride.driverId, {
            totalRides: (driver.totalRides || 0) + 1,
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

  app.get("/api/drivers/me/wallet", async (_req: Request, res: Response) => {
    const driverId = authenticatedDriverId(res);
    if (!driverId) return res.status(403).json({ message: "Only drivers can view a wallet." });
    return res.json(await routeStorage.getDriverWallet(driverId));
  });

  app.get("/api/drivers/me/settlements", async (_req: Request, res: Response) => {
    const driverId = authenticatedDriverId(res);
    if (!driverId) return res.status(403).json({ message: "Only drivers can view settlements." });
    return res.json(await routeStorage.getSettlements({ driverId }));
  });

  app.post("/api/drivers/me/settlements", async (req: Request, res: Response) => {
    const driverId = authenticatedDriverId(res);
    if (!driverId) return res.status(403).json({ message: "Only drivers can request settlements." });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Enter a positive settlement amount in Maloti." });
    try {
      const settlement = await routeStorage.createSettlement(driverId, Math.round(amount * 100));
      return res.status(201).json(settlement);
    } catch (error: any) {
      return res.status(409).json({ message: error?.message || "Could not request settlement." });
    }
  });

  app.get("/api/events/:userId", async (req: Request, res: Response) => {
    if (res.locals.auth && authenticatedUserId(res) !== getRouteParam(req.params.userId)) return res.status(403).json({ message: "Access denied" });
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
    const postedLedger = (await routeStorage.getLedgerTransactions()).filter(transaction => transaction.status === 'posted' && transaction.category === 'ride_earnings');
    const totalRevenue = postedLedger.reduce((sum, transaction) => sum + transaction.amountMinor / 100, 0);
    const totalDriverEarnings = postedLedger.reduce((sum, transaction) => sum + Number(transaction.metadata?.driverEarningsMinor || 0) / 100, 0);
    const platformRevenue = postedLedger.reduce((sum, transaction) => sum + Number(transaction.metadata?.platformCommissionMinor || 0) / 100, 0);

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
      if (safe.role === 'driver' && safe.kyc) {
        safe.kyc = { status: safe.kyc.status, submittedAt: safe.kyc.submittedAt, reviewedAt: safe.kyc.reviewedAt, rejectionReason: safe.kyc.rejectionReason };
      }
      if (safe.role === 'driver') delete safe.vehiclePhotos;
      return safe;
    });
    return res.json(filtered);
  });

  app.post("/api/admin/users", async (req: Request, res: Response) => {
    try {
      const parsed = registerSchema.parse(req.body);
      const temporaryPassword = typeof req.body?.password === 'string' ? req.body.password : '';
      if (temporaryPassword.length < 8) {
        return res.status(400).json({ message: "Use a temporary password with at least 8 characters." });
      }
      if (await routeStorage.getUserByUsername(parsed.username)) {
        return res.status(409).json({ message: "That username is already in use. Choose another one." });
      }
      const created = await routeStorage.createUser({
        username: parsed.username,
        password: await hashPassword(temporaryPassword),
        role: parsed.role,
        fullName: parsed.fullName,
        phone: parsed.phone,
        email: typeof req.body?.email === 'string' ? req.body.email.trim() || undefined : undefined,
        active: true,
        isOnline: false,
        vehicleInfo: parsed.vehicleInfo,
        rating: parsed.role === 'driver' ? 5 : undefined,
        totalRides: 0,
        totalEarnings: 0,
      });
      return res.status(201).json(publicUser(created));
    } catch (error: any) {
      return res.status(400).json({ message: error?.message || "Could not create the account." });
    }
  });

  app.get("/api/admin/users/:id/profile", async (req: Request, res: Response) => {
    const user = await routeStorage.getUser(getRouteParam(req.params.id));
    if (!user || user.role === 'admin') return res.status(404).json({ message: "User not found" });
    const rides = user.role === 'driver'
      ? await routeStorage.getRidesByDriver(user.id)
      : await routeStorage.getRidesByRider(user.id);
    const wallet = user.role === 'driver' ? await routeStorage.getDriverWallet(user.id) : null;
    const settlements = user.role === 'driver' ? await routeStorage.getSettlements({ driverId: user.id }) : [];
    const ledger = user.role === 'driver' ? await routeStorage.getLedgerTransactions({ driverId: user.id }) : [];
    const activity = await routeStorage.getEventsByUser(user.id);
    return res.json({ user: publicUser(user), rides, wallet, settlements, ledger, activity });
  });

  app.put("/api/admin/users/:id", async (req: Request, res: Response) => {
    const user = await routeStorage.getUser(getRouteParam(req.params.id));
    if (!user || user.role === 'admin') return res.status(404).json({ message: "User not found" });
    const updates: Partial<typeof user> = {};
    if (typeof req.body?.fullName === 'string' && req.body.fullName.trim()) updates.fullName = req.body.fullName.trim();
    if (typeof req.body?.phone === 'string' && req.body.phone.trim()) updates.phone = req.body.phone.trim();
    if (typeof req.body?.email === 'string') updates.email = req.body.email.trim() || undefined;
    if (req.body?.vehicleInfo !== undefined && user.role === 'driver') updates.vehicleInfo = req.body.vehicleInfo;
    const updated = await routeStorage.updateUser(user.id, updates);
    return res.json(updated ? publicUser(updated) : publicUser(user));
  });

  app.put("/api/admin/users/:id/active", async (req: Request, res: Response) => {
    const user = await routeStorage.getUser(getRouteParam(req.params.id));
    if (!user || user.role === 'admin') return res.status(404).json({ message: "User not found" });
    const active = typeof req.body?.active === 'boolean' ? req.body.active : user.active !== false;
    const updated = await routeStorage.updateUser(user.id, { active, isOnline: active ? user.isOnline : false });
    return res.json(updated ? publicUser(updated) : publicUser(user));
  });

  app.get("/api/admin/wallets/:driverId", async (req: Request, res: Response) => {
    const driver = await routeStorage.getUser(getRouteParam(req.params.driverId));
    if (!driver || driver.role !== 'driver') return res.status(404).json({ message: "Driver not found" });
    return res.json(await routeStorage.getDriverWallet(driver.id));
  });

  app.get("/api/admin/ledger", async (req: Request, res: Response) => {
    const driverId = typeof req.query.driverId === 'string' ? req.query.driverId : undefined;
    const rideId = typeof req.query.rideId === 'string' ? req.query.rideId : undefined;
    return res.json(await routeStorage.getLedgerTransactions({ driverId, rideId }));
  });

  app.get("/api/admin/settlements", async (req: Request, res: Response) => {
    const driverId = typeof req.query.driverId === 'string' ? req.query.driverId : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status as any : undefined;
    return res.json(await routeStorage.getSettlements({ driverId, status }));
  });

  app.post("/api/admin/settlements", async (req: Request, res: Response) => {
    const driverId = typeof req.body?.driverId === 'string' ? req.body.driverId : '';
    const amount = Number(req.body?.amount);
    const driver = await routeStorage.getUser(driverId);
    if (!driver || driver.role !== 'driver') return res.status(404).json({ message: "Driver not found" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Enter a positive settlement amount in Maloti." });
    try {
      const settlement = await routeStorage.createSettlement(driverId, Math.round(amount * 100));
      return res.status(201).json(settlement);
    } catch (error: any) {
      return res.status(409).json({ message: error?.message || "Could not create settlement." });
    }
  });

  app.put("/api/admin/settlements/:id", async (req: Request, res: Response) => {
    const status = req.body?.status;
    const validStatuses = ['UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'FAILED', 'CANCELLED'];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: "Choose a valid settlement status." });
    try {
      const settlement = await routeStorage.updateSettlement(getRouteParam(req.params.id), {
        status,
        rejectionReason: typeof req.body?.rejectionReason === 'string' ? req.body.rejectionReason.trim() : undefined,
        paymentReference: typeof req.body?.paymentReference === 'string' ? req.body.paymentReference.trim() : undefined,
        paymentEvidence: typeof req.body?.paymentEvidence === 'string' ? req.body.paymentEvidence : undefined,
      }, res.locals.auth?.sub);
      if (!settlement) return res.status(404).json({ message: "Settlement not found" });
      return res.json(settlement);
    } catch (error: any) {
      return res.status(409).json({ message: error?.message || "Settlement could not be updated." });
    }
  });

  app.get("/api/admin/kyc", async (_req: Request, res: Response) => {
    const drivers = (await routeStorage.getAllUsers()).filter(user => user.role === 'driver' && user.kyc?.status && user.kyc.status !== 'not_submitted');
    return res.json(drivers.map(({ password: _, ...driver }) => ({
      id: driver.id,
      fullName: driver.fullName,
      phone: driver.phone,
      vehicleInfo: driver.vehicleInfo,
      vehiclePhotos: driver.vehiclePhotos ?? [],
      kyc: driver.kyc,
    })));
  });

  app.put("/api/admin/users/:id/kyc", async (req: Request, res: Response) => {
    const userId = getRouteParam(req.params.id);
    const user = await routeStorage.getUser(userId);
    if (!user || user.role !== 'driver') return res.status(404).json({ message: "Driver not found." });
    const status = req.body?.status;
    if (status !== 'approved' && status !== 'rejected') return res.status(400).json({ message: "KYC status must be approved or rejected." });
    const updated = await routeStorage.updateUser(userId, {
      kyc: {
        ...(user.kyc ?? { status: 'not_submitted' }),
        status,
        reviewedAt: new Date().toISOString(),
        reviewedBy: res.locals.auth?.sub,
        rejectionReason: status === 'rejected' ? String(req.body?.rejectionReason || 'Documents need correction.') : undefined,
      },
    });
    return res.json({ kyc: updated?.kyc });
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
    if (res.locals.auth && (res.locals.auth.role !== 'rider' || ride.riderId !== authenticatedUserId(res))) return res.status(403).json({ message: "Only the rider can review this ride" });
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
    const serviceType = req.query.serviceType === 'parcel' ? 'parcel' : 'ride';
    let parcel;
    if (serviceType === 'parcel') {
      const values = ['parcelWeightKg', 'parcelLengthCm', 'parcelWidthCm', 'parcelHeightCm'].map(key => Number(req.query[key]));
      if (values.some(value => !Number.isFinite(value) || value <= 0)) {
        return res.status(400).json({ message: "Valid parcel weight and dimensions are required" });
      }
      parcel = { weightKg: values[0], lengthCm: values[1], widthCm: values[2], heightCm: values[3] };
    }
    const distance = calculateDistance(pLat, pLng, dLat, dLng);
    const duration = Math.round(distance * (3 / 1.609344));
    const fare = await routeStorage.calculateFareForDistance(
      distance, additionalPassengers, rideType, parcel
    );

    return res.json({
      distance: Math.round(distance * 10) / 10,
      duration,
      serviceType,
      ...fare,
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}
