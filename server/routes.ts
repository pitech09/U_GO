import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import { storage } from "./storage";
import { registerSchema, loginSchema, requestRideSchema, updateLocationSchema } from "@shared/schema";
import type { RideStatus } from "@shared/schema";

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function registerRoutes(app: Express): Promise<Server> {

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const parsed = registerSchema.parse(req.body);
      const existing = await storage.getUserByUsername(parsed.username);
      if (existing) {
        return res.status(400).json({ message: "Username already taken" });
      }
      const user = await storage.createUser({
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
      const user = await storage.getUserByUsername(parsed.username);
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
    const user = await storage.getUser(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const { password: _, ...safe } = user;
    return res.json(safe);
  });

  app.put("/api/user/:id/location", async (req: Request, res: Response) => {
    try {
      const parsed = updateLocationSchema.parse(req.body);
      const user = await storage.updateUser(req.params.id, {
        currentLocation: { lat: parsed.lat, lng: parsed.lng },
      });
      if (!user) return res.status(404).json({ message: "User not found" });
      return res.json({ success: true });
    } catch (e: any) {
      return res.status(400).json({ message: e.message });
    }
  });

  app.put("/api/user/:id/online", async (req: Request, res: Response) => {
    const { isOnline } = req.body;
    const user = await storage.updateUser(req.params.id, { isOnline });
    if (!user) return res.status(404).json({ message: "User not found" });
    const { password: _, ...safe } = user;
    return res.json(safe);
  });

  app.get("/api/drivers/nearby", async (req: Request, res: Response) => {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radius = parseFloat(req.query.radius as string) || 10;
    const excludeId = req.query.exclude as string;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ message: "lat and lng required" });
    }

    const onlineDrivers = await storage.getOnlineDrivers();
    const nearby = onlineDrivers
      .filter(d => d.currentLocation && d.id !== excludeId)
      .map(d => {
        const dist = calculateDistance(lat, lng, d.currentLocation!.lat, d.currentLocation!.lng);
        return { ...d, distance: Math.round(dist * 10) / 10, password: undefined };
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

      const rider = await storage.getUser(riderId);
      if (!rider) return res.status(404).json({ message: "Rider not found" });

      const ride = await storage.createRide({
        riderId,
        status: 'requested',
        pickup: parsed.pickup,
        dropoff: parsed.dropoff,
        riderName: rider.fullName,
      });

      await storage.createEvent({
        type: 'ride_requested',
        rideId: ride.id,
        userId: riderId,
        data: { pickup: ride.pickup, dropoff: ride.dropoff, fare: ride.fare },
        read: false,
      });

      const onlineDrivers = await storage.getOnlineDrivers();
      for (const driver of onlineDrivers) {
        if (driver.currentLocation) {
          const dist = calculateDistance(
            parsed.pickup.lat, parsed.pickup.lng,
            driver.currentLocation.lat, driver.currentLocation.lng
          );
          if (dist <= 15) {
            await storage.createEvent({
              type: 'ride_requested',
              rideId: ride.id,
              userId: driver.id,
              data: { pickup: ride.pickup, dropoff: ride.dropoff, fare: ride.fare, riderName: rider.fullName },
              read: false,
            });
          }
        }
      }

      return res.json(ride);
    } catch (e: any) {
      return res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/rides/available", async (_req: Request, res: Response) => {
    const active = await storage.getActiveRides();
    const requested = active.filter(r => r.status === 'requested');
    return res.json(requested);
  });

  app.get("/api/rides/rider/:riderId", async (req: Request, res: Response) => {
    const rides = await storage.getRidesByRider(req.params.riderId);
    const sanitized = rides.map(r => {
      if (r.review) return { ...r, review: { rating: r.review.rating, createdAt: r.review.createdAt } };
      return r;
    });
    return res.json(sanitized);
  });

  app.get("/api/rides/driver/:driverId", async (req: Request, res: Response) => {
    const rides = await storage.getRidesByDriver(req.params.driverId);
    const sanitized = rides.map(r => {
      if (r.review) return { ...r, review: { rating: r.review.rating, createdAt: r.review.createdAt } };
      return r;
    });
    return res.json(sanitized);
  });

  app.get("/api/rides/driver/:driverId/active", async (req: Request, res: Response) => {
    const rides = await storage.getRidesByDriver(req.params.driverId);
    const active = rides.find(r => !['completed', 'cancelled'].includes(r.status));
    return res.json(active || null);
  });

  app.get("/api/rides/rider/:riderId/active", async (req: Request, res: Response) => {
    const rides = await storage.getRidesByRider(req.params.riderId);
    const active = rides.find(r => !['completed', 'cancelled'].includes(r.status));
    if (active) return res.json(active);

    const recentCompleted = rides
      .filter(r => r.status === 'completed' && r.completedAt)
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
    const ride = await storage.getRide(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    return res.json(ride);
  });

  app.put("/api/rides/:id/accept", async (req: Request, res: Response) => {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ message: "driverId required" });

    const ride = await storage.getRide(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (ride.status !== 'requested') return res.status(400).json({ message: "Ride already accepted" });

    const driver = await storage.getUser(driverId);
    if (!driver) return res.status(404).json({ message: "Driver not found" });

    const updated = await storage.updateRide(req.params.id, {
      driverId,
      driverName: driver.fullName,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    });

    await storage.createEvent({
      type: 'ride_accepted',
      rideId: ride.id,
      userId: ride.riderId,
      data: { driverName: driver.fullName, vehicleInfo: driver.vehicleInfo },
      read: false,
    });

    return res.json(updated);
  });

  app.put("/api/rides/:id/status", async (req: Request, res: Response) => {
    const { status } = req.body as { status: RideStatus };
    const ride = await storage.getRide(req.params.id);
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
        const driver = await storage.getUser(ride.driverId);
        if (driver) {
          await storage.updateUser(ride.driverId, {
            totalRides: (driver.totalRides || 0) + 1,
            totalEarnings: (driver.totalEarnings || 0) + ride.fare.driverEarnings,
          });
        }
      }
    }

    const updated = await storage.updateRide(req.params.id, updates);

    const eventTypeMap: Record<string, string> = {
      arriving: 'driver_arriving',
      arrived: 'driver_arrived',
      in_progress: 'ride_started',
      completed: 'ride_completed',
      cancelled: 'ride_cancelled',
    };
    const eventType = eventTypeMap[status];
    if (eventType && ride.riderId) {
      await storage.createEvent({
        type: eventType as any,
        rideId: ride.id,
        userId: ride.riderId,
        data: { status, fare: ride.fare },
        read: false,
      });
    }
    if (eventType && ride.driverId) {
      await storage.createEvent({
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
    const events = await storage.getEventsByUser(req.params.userId);
    return res.json(events);
  });

  app.put("/api/events/:eventId/read", async (req: Request, res: Response) => {
    await storage.markEventRead(req.params.eventId);
    return res.json({ success: true });
  });

  app.get("/api/admin/stats", async (_req: Request, res: Response) => {
    const allRides = await storage.getAllRides();
    const allUsers = await storage.getAllUsers();
    const drivers = allUsers.filter(u => u.role === 'driver');
    const riders = allUsers.filter(u => u.role === 'rider');
    const activeRides = await storage.getActiveRides();
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
    const rides = await storage.getAllRides();
    return res.json(rides);
  });

  app.get("/api/admin/users", async (_req: Request, res: Response) => {
    const allUsers = await storage.getAllUsers();
    const filtered = allUsers.filter(u => u.role !== 'admin').map(u => {
      const { password: _, ...safe } = u;
      return safe;
    });
    return res.json(filtered);
  });

  app.put("/api/admin/users/:id/suspend", async (req: Request, res: Response) => {
    const user = await storage.getUser(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role === 'admin') return res.status(403).json({ message: "Cannot suspend admin" });
    const updated = await storage.updateUser(req.params.id, {
      suspended: !user.suspended,
      isOnline: user.suspended ? user.isOnline : false,
    });
    if (!updated) return res.status(500).json({ message: "Update failed" });
    const { password: _, ...safe } = updated;
    return res.json(safe);
  });

  app.delete("/api/admin/users/:id", async (req: Request, res: Response) => {
    const user = await storage.getUser(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role === 'admin') return res.status(403).json({ message: "Cannot remove admin" });
    await storage.deleteUser(req.params.id);
    return res.json({ success: true });
  });

  app.put("/api/admin/rides/:id/cancel", async (req: Request, res: Response) => {
    const ride = await storage.getRide(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (['completed', 'cancelled'].includes(ride.status)) {
      return res.status(400).json({ message: "Ride already " + ride.status });
    }
    const updated = await storage.updateRide(req.params.id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    return res.json(updated);
  });

  app.get("/api/admin/config", async (_req: Request, res: Response) => {
    const config = await storage.getConfig();
    return res.json(config);
  });

  app.put("/api/admin/config", async (req: Request, res: Response) => {
    const config = await storage.updateConfig(req.body);
    return res.json(config);
  });

  app.put("/api/rides/:id/review", async (req: Request, res: Response) => {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }
    const ride = await storage.getRide(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });
    if (ride.status !== 'completed') return res.status(400).json({ message: "Can only review completed rides" });
    if (ride.review) return res.status(400).json({ message: "Ride already reviewed" });

    const review = {
      rating: Math.round(rating),
      comment: comment?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    const updated = await storage.updateRide(req.params.id, { review });

    if (ride.driverId) {
      const driverRides = await storage.getRidesByDriver(ride.driverId);
      const reviewedRides = driverRides.filter(r => r.review);
      const totalRating = reviewedRides.reduce((sum, r) => sum + (r.review?.rating || 0), 0) + rating;
      const avgRating = totalRating / (reviewedRides.length + 1);
      await storage.updateUser(ride.driverId, { rating: Math.round(avgRating * 10) / 10 });
    }

    return res.json(updated);
  });

  app.get("/api/rides/rider/:riderId/recent-completed", async (req: Request, res: Response) => {
    const rides = await storage.getRidesByRider(req.params.riderId);
    const completed = rides.find(r => r.status === 'completed' && !r.review);
    return res.json(completed || null);
  });

  app.get("/api/fare/estimate", async (req: Request, res: Response) => {
    const pLat = parseFloat(req.query.pLat as string);
    const pLng = parseFloat(req.query.pLng as string);
    const dLat = parseFloat(req.query.dLat as string);
    const dLng = parseFloat(req.query.dLng as string);

    if (isNaN(pLat) || isNaN(pLng) || isNaN(dLat) || isNaN(dLng)) {
      return res.status(400).json({ message: "Coordinates required" });
    }

    const config = await storage.getConfig();
    const distance = calculateDistance(pLat, pLng, dLat, dLng);
    const estimatedMinutes = distance * 3;
    const distanceFare = distance * config.perMile;
    const timeFare = estimatedMinutes * config.perMinute;
    let totalFare = Math.max(config.baseFare + distanceFare + timeFare, config.minimumFare);
    if (config.surgePricing) totalFare *= config.surgeMultiplier;
    const driverPercent = config.driverSharePercent / 100;

    return res.json({
      distance: Math.round(distance * 10) / 10,
      duration: Math.round(estimatedMinutes),
      baseFare: Math.round(config.baseFare * 100) / 100,
      distanceFare: Math.round(distanceFare * 100) / 100,
      timeFare: Math.round(timeFare * 100) / 100,
      totalFare: Math.round(totalFare * 100) / 100,
      driverEarnings: Math.round(totalFare * driverPercent * 100) / 100,
      platformFee: Math.round(totalFare * (1 - driverPercent) * 100) / 100,
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}
