import { calculateDistance } from "../shared/distance";
import { randomUUID } from "crypto";
import { calculateFareBreakdown } from "../shared/fare";
import Redis from "ioredis";
import type { User, Ride, WebhookEvent, UserRole, PlatformConfig, RideType } from "@shared/schema";

export interface RideDispatchState {
  rideId: string;
  round: number;
  radiusKm: number;
  nextDispatchAt: number;
  status: "scheduled" | "completed";
  updatedAt: number;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: Omit<User, 'id' | 'createdAt'>): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  getUsersByRole(role: UserRole): Promise<User[]>;
  getAllUsers(): Promise<User[]>;
  getOnlineDrivers(): Promise<User[]>;

  createRide(ride: Omit<Ride, 'id' | 'createdAt'>): Promise<Ride>;
  getRide(id: string): Promise<Ride | undefined>;
  updateRide(id: string, updates: Partial<Ride>): Promise<Ride | undefined>;
  getRidesByRider(riderId: string): Promise<Ride[]>;
  getRidesByDriver(driverId: string): Promise<Ride[]>;
  getActiveRides(): Promise<Ride[]>;
  getAllRides(): Promise<Ride[]>;
  createRideOffer(
    driverId: string,
    rideId: string,
    offerWindowSeconds?: number
  ): Promise<boolean>;
  expireRideOffersForRide(rideId: string): Promise<number>;
  getPendingRideOfferExpiry(rideId: string, now: number): Promise<number>;
  finishRideDispatchNoDrivers(rideId: string): Promise<boolean>;
  startRideDispatch(rideId: string): Promise<boolean>;
  getDueRideDispatches(now: number, limit?: number): Promise<RideDispatchState[]>;
  getRideDispatch(rideId: string): Promise<RideDispatchState | undefined>;
  saveRideDispatch(state: RideDispatchState): Promise<void>;
  acquireDispatchLock(token: string, ttlMs: number): Promise<boolean>;
  releaseDispatchLock(token: string): Promise<boolean>;
  getDriverRideOffers(driverId: string): Promise<Array<Ride & { offerExpiresAt: number }>>;
  getRideOffersForRider(riderId: string): Promise<Array<{
    rideId: string;
    ride: Ride;
    driverId: string;
    offer: {
      driverId: string;
      rideId: string;
      createdAt: number;
      expiresAt: number;
      status: 'pending' | 'expired';
    };
  }>>;
  rejectRideOffer(driverId: string, rideId: string): Promise<boolean>;
  acceptRideOffer(driverId: string, rideId: string, driverName: string): Promise<{
    status:
      | 'accepted'
      | 'not_available'
      | 'active_ride'
      | 'offer_missing'
      | 'not_driver'
      | 'driver_offline'
      | 'driver_suspended'
      | 'capacity_unverified'
      | 'capacity_exceeded';
    ride?: Ride;
  }>;

  createEvent(event: Omit<WebhookEvent, 'id' | 'createdAt'>): Promise<WebhookEvent>;
  getEventsByUser(userId: string): Promise<WebhookEvent[]>;
  markEventRead(eventId: string): Promise<void>;

  getConfig(): Promise<PlatformConfig>;
  calculateFareForDistance(distanceKm: number, additionalPassengers?: number, rideType?: RideType): Promise<{
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
  }>;
  updateConfig(updates: Partial<PlatformConfig>): Promise<PlatformConfig>;

  initialize(): Promise<void>;
}


const DEFAULT_CONFIG: PlatformConfig = {
  baseFare: 20,
  perKm: 12,
  perMinute: 0.35,
  driverSharePercent: 88,
  minimumFare: 20,
  surgePricing: false,
  surgeMultiplier: 1.0,
  sharedRideDiscountPercent: 15,
  groupDiscountPercent: 20,
  passengerPricingMode: 'fixed',
  additionalPassengerFee: 0,
  additionalPassengerMultiplier: 1.0,
  dispatchInitialRadiusKm: 15,
  dispatchRadiusIncrementKm: 5,
  dispatchMaximumRadiusKm: 30,
  dispatchOfferWindowSeconds: 45,
};

const FARE_MODEL_VERSION = 2;

export class RedisStorage implements IStorage {
  private redis: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL;

    if (process.env.NODE_ENV === 'production' && !redisUrl) {
      throw new Error('REDIS_URL must be configured in production');
    }

    const connectionUrl = redisUrl ||
      `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || '6379'}`;

    this.redis = new Redis(connectionUrl, {
      retryStrategy(times) {
        if (times > 10) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });
  }

  async initialize(): Promise<void> {
    await this.redis.connect();
    console.log('Connected to Redis');

    const seeded = await this.redis.get('rideflow:seeded');
    if (!seeded) {
      await this.seed();
      await this.redis.set('rideflow:seeded', '1');
      console.log('Seeded default data');
    } else {
      console.log('Redis data already exists, skipping seed');
    }
  }

  private async seed(): Promise<void> {
    const adminId = randomUUID();
    const admin: User = {
      id: adminId,
      username: 'admin',
      password: 'admin123',
      role: 'admin',
      fullName: 'Platform Admin',
      phone: '0000000000',
      createdAt: new Date().toISOString(),
    };
    await this.redis.hset('rideflow:users', adminId, JSON.stringify(admin));
    await this.redis.hset('rideflow:usernames', 'admin', adminId);

  }

  async getUser(id: string): Promise<User | undefined> {
    const data = await this.redis.hget('rideflow:users', id);
    return data ? JSON.parse(data) : undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const userId = await this.redis.hget('rideflow:usernames', username);
    if (!userId) return undefined;
    return this.getUser(userId);
  }

  async createUser(user: Omit<User, 'id' | 'createdAt'>): Promise<User> {
    const id = randomUUID();
    const newUser: User = { ...user, id, createdAt: new Date().toISOString() };
    await this.redis.hset('rideflow:users', id, JSON.stringify(newUser));
    await this.redis.hset('rideflow:usernames', newUser.username, id);
    return newUser;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const user = await this.getUser(id);
    if (!user) return undefined;
    const updated = { ...user, ...updates };
    await this.redis.hset('rideflow:users', id, JSON.stringify(updated));
    if (updates.username && updates.username !== user.username) {
      await this.redis.hdel('rideflow:usernames', user.username);
      await this.redis.hset('rideflow:usernames', updates.username, id);
    }
    return updated;
  }

  async deleteUser(id: string): Promise<boolean> {
    const user = await this.getUser(id);
    if (!user) return false;
    await this.redis.hdel('rideflow:users', id);
    await this.redis.hdel('rideflow:usernames', user.username);
    return true;
  }

  async getUsersByRole(role: UserRole): Promise<User[]> {
    const all = await this.getAllUsers();
    return all.filter(u => u.role === role);
  }

  async getAllUsers(): Promise<User[]> {
    const data = await this.redis.hvals('rideflow:users');
    return data.map(d => JSON.parse(d));
  }

  async getOnlineDrivers(): Promise<User[]> {
    const all = await this.getAllUsers();
    return all.filter(u => u.role === 'driver' && u.isOnline === true && !u.suspended);
  }

  private async getConfigInternal(): Promise<PlatformConfig> {
    const data = await this.redis.get('rideflow:config');
    if (!data) return { ...DEFAULT_CONFIG };

    const parsed = JSON.parse(data) as Partial<PlatformConfig> & {
      perMile?: number;
      fareModelVersion?: number;
    };
    const { perMile, ...rest } = parsed;

    // One-time migration from the previous fare models. Existing Redis data
    // may contain the old passenger-multiplied tariff, so reset the pricing
    // fields to the current defaults before calculating any new fares.
    if (
      typeof perMile === 'number' ||
      parsed.fareModelVersion !== FARE_MODEL_VERSION
    ) {
      const migrated: PlatformConfig = {
        ...DEFAULT_CONFIG,
        ...rest,
        baseFare: 20,
        perKm: 12,
        perMinute: 0.35,
        driverSharePercent: 88,
        minimumFare: 20,
        surgePricing: false,
        surgeMultiplier: 1,
        sharedRideDiscountPercent: 15,
        groupDiscountPercent: 20,
        passengerPricingMode: 'fixed',
        additionalPassengerFee: 0,
        additionalPassengerMultiplier: 1,
      };
      await this.redis.set('rideflow:config', JSON.stringify({
        ...migrated,
        fareModelVersion: FARE_MODEL_VERSION,
      }));
      return migrated;
    }

    return {
      ...DEFAULT_CONFIG,
      ...rest,
      perKm: typeof parsed.perKm === 'number' ? parsed.perKm : DEFAULT_CONFIG.perKm,
    };
  }

  private async calculateFare(
    distanceKm: number,
    additionalPassengers = 0,
    rideType: RideType = "private"
  ) {
    const config = await this.getConfigInternal();
    return calculateFareBreakdown(distanceKm, config, additionalPassengers, rideType);
  }

  async calculateFareForDistance(
    distanceKm: number,
    additionalPassengers = 0,
    rideType: RideType = 'private'
  ) {
    return this.calculateFare(distanceKm, additionalPassengers, rideType);
  }

  async createRide(ride: Omit<Ride, 'id' | 'createdAt'>): Promise<Ride> {
    const id = randomUUID();
    const distance = calculateDistance(
      ride.pickup.lat, ride.pickup.lng,
      ride.dropoff.lat, ride.dropoff.lng
    );
    const additionalPassengers = ride.additionalPassengers ?? 0;
    const fare = await this.calculateFare(distance, additionalPassengers, ride.rideType ?? 'private');
    const newRide: Ride = {
      ...ride,
      rideType: ride.rideType ?? 'private',
      additionalPassengers,
      passengerCount: 1 + additionalPassengers,
      id,
      createdAt: new Date().toISOString(),
      distance: Math.round(distance * 10) / 10,
      duration: Math.round(distance * (3 / 1.609344)),
      fare,
    };
    await this.redis.hset('rideflow:rides', id, JSON.stringify(newRide));
    return newRide;
  }

  async getRide(id: string): Promise<Ride | undefined> {
    const data = await this.redis.hget('rideflow:rides', id);
    return data ? JSON.parse(data) : undefined;
  }

  async updateRide(id: string, updates: Partial<Ride>): Promise<Ride | undefined> {
    const ride = await this.getRide(id);
    if (!ride) return undefined;
    const updated = { ...ride, ...updates };
    await this.redis.hset('rideflow:rides', id, JSON.stringify(updated));
    return updated;
  }

  async getRidesByRider(riderId: string): Promise<Ride[]> {
    const all = await this.getAllRides();
    return all.filter(r => r.riderId === riderId);
  }

  async getRidesByDriver(driverId: string): Promise<Ride[]> {
    const all = await this.getAllRides();
    return all.filter(r => r.driverId === driverId);
  }

  async getActiveRides(): Promise<Ride[]> {
    const all = await this.getAllRides();
    return all.filter(r => !['completed', 'cancelled', 'no_drivers_available'].includes(r.status));
  }

  async getAllRides(): Promise<Ride[]> {
    const data = await this.redis.hvals('rideflow:rides');
    return data
      .map(d => JSON.parse(d) as Ride)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async finishRideDispatchNoDrivers(rideId: string): Promise<boolean> {
    const now = Date.now();

    const script = `
      local rideData = redis.call('HGET', KEYS[1], ARGV[1])
      if not rideData then return 0 end

      local ride = cjson.decode(rideData)
      if ride.status ~= 'requested' then return -1 end

      ride.status = 'no_drivers_available'
      redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(ride))

      local stateData = redis.call('HGET', KEYS[2], ARGV[1])
      local state

      if stateData then
        state = cjson.decode(stateData)
      else
        state = {
          rideId = ARGV[1],
          round = 0,
          radiusKm = 0,
          nextDispatchAt = tonumber(ARGV[2]),
          status = 'completed'
        }
      end

      state.status = 'completed'
      state.updatedAt = tonumber(ARGV[2])

      redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(state))
      redis.call('ZREM', KEYS[3], ARGV[1])

      return 1
    `;

    const result = await this.redis.eval(
      script,
      3,
      'rideflow:rides',
      'rideflow:dispatches',
      'rideflow:dispatch_due',
      rideId,
      String(now)
    );

    return Number(result) === 1;
  }

  async startRideDispatch(rideId: string): Promise<boolean> {
    const now = Date.now();

    const state: RideDispatchState = {
      rideId,
      round: 0,
      radiusKm: 0,
      nextDispatchAt: now,
      status: "scheduled",
      updatedAt: now,
    };

    const script = `
      local rideData = redis.call('HGET', KEYS[1], ARGV[1])
      if not rideData then return 0 end

      local ride = cjson.decode(rideData)
      if ride.status ~= 'requested' then return 0 end

      if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
        return 0
      end

      redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
      redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
      return 1
    `;

    const result = await this.redis.eval(
      script,
      3,
      'rideflow:rides',
      'rideflow:dispatches',
      'rideflow:dispatch_due',
      rideId,
      JSON.stringify(state),
      String(now)
    );

    return Number(result) === 1;
  }

  async getPendingRideOfferExpiry(
    rideId: string,
    now: number
  ): Promise<number> {
    const script = `
      local rideData = redis.call('HGET', KEYS[1], ARGV[1])
      if not rideData then return -1 end

      local ride = cjson.decode(rideData)
      if ride.status ~= 'requested' then return -1 end

      local drivers = redis.call('SMEMBERS', KEYS[3])
      local latestExpiry = 0

      for _, driverId in ipairs(drivers) do
        local offerData = redis.call(
          'HGET',
          KEYS[2],
          driverId .. ':' .. ARGV[1]
        )

        if offerData then
          local offer = cjson.decode(offerData)
          local expiresAt = tonumber(offer.expiresAt) or 0

          if offer.status == 'pending' and expiresAt > tonumber(ARGV[2]) then
            if expiresAt > latestExpiry then
              latestExpiry = expiresAt
            end
          end
        end
      end

      return latestExpiry
    `;

    const result = await this.redis.eval(
      script,
      3,
      'rideflow:rides',
      'rideflow:offers',
      `rideflow:ride_offered_drivers:${rideId}`,
      rideId,
      String(now)
    );

    return Number(result);
  }

  async getDueRideDispatches(
    now: number,
    limit = 20
  ): Promise<RideDispatchState[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

    const rideIds = await this.redis.zrangebyscore(
      'rideflow:dispatch_due',
      '-inf',
      now,
      'LIMIT',
      0,
      safeLimit
    );

    if (!rideIds.length) return [];

    const states = await Promise.all(
      rideIds.map(id => this.getRideDispatch(id))
    );

    return states.filter(
      (state): state is RideDispatchState =>
        state !== undefined &&
        state.status === "scheduled" &&
        state.nextDispatchAt <= now
    );
  }

  async getRideDispatch(
    rideId: string
  ): Promise<RideDispatchState | undefined> {
    const data = await this.redis.hget('rideflow:dispatches', rideId);
    return data ? JSON.parse(data) as RideDispatchState : undefined;
  }

  async saveRideDispatch(state: RideDispatchState): Promise<void> {
    const script = `
      redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])

      if ARGV[3] == 'scheduled' then
        redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
      else
        redis.call('ZREM', KEYS[2], ARGV[1])
      end

      return 1
    `;

    await this.redis.eval(
      script,
      2,
      'rideflow:dispatches',
      'rideflow:dispatch_due',
      state.rideId,
      JSON.stringify(state),
      state.status,
      String(state.nextDispatchAt)
    );
  }

  async acquireDispatchLock(
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Dispatch lock TTL must be positive.");
    }

    const result = await this.redis.set(
      'rideflow:dispatch_lock',
      token,
      'PX',
      Math.floor(ttlMs),
      'NX'
    );

    return result === 'OK';
  }

  async releaseDispatchLock(token: string): Promise<boolean> {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;

    const result = await this.redis.eval(
      script,
      1,
      'rideflow:dispatch_lock',
      token
    );

    return Number(result) === 1;
  }

  async createRideOffer(
    driverId: string,
    rideId: string,
    offerWindowSeconds = 45
  ): Promise<boolean> {
    const now = Date.now();
    const safeWindowSeconds =
      Number.isFinite(offerWindowSeconds) && offerWindowSeconds > 0
        ? offerWindowSeconds
        : 45;
    const expiresAt = now + safeWindowSeconds * 1000;
    const offerKey = `${driverId}:${rideId}`;

    const script = `
      local rideData = redis.call('HGET', KEYS[1], ARGV[1])
      if not rideData then return 0 end
      local ride = cjson.decode(rideData)
      if ride.status ~= 'requested' then return 0 end
      if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then return 0 end
      if redis.call('SISMEMBER', KEYS[5], ARGV[2]) == 1 then return 0 end
      if redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
      if redis.call('ZCARD', KEYS[2]) >= 5 then return 0 end

      local offer = {
        driverId = ARGV[2],
        rideId = ARGV[1],
        createdAt = tonumber(ARGV[3]),
        expiresAt = tonumber(ARGV[4]),
        status = 'pending'
      }

      redis.call('HSET', KEYS[3], ARGV[5], cjson.encode(offer))
      redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
      redis.call('SADD', KEYS[5], ARGV[2])
      return 1
    `;

    const result = await this.redis.eval(
      script,
      5,
      'rideflow:rides',
      `rideflow:driver_offers:${driverId}`,
      'rideflow:offers',
      `rideflow:driver_rejections:${driverId}`,
      `rideflow:ride_offered_drivers:${rideId}`,
      rideId,
      driverId,
      String(now),
      String(expiresAt),
      offerKey
    );

    return Number(result) === 1;
  }

  async expireRideOffersForRide(rideId: string): Promise<number> {
    const script = `
      local rideData = redis.call('HGET', KEYS[1], ARGV[1])
      if not rideData then return -1 end

      local ride = cjson.decode(rideData)
      if ride.status ~= 'requested' then return -1 end

      local now = tonumber(ARGV[2])
      local drivers = redis.call('SMEMBERS', KEYS[3])
      local expiredCount = 0

      for _, driverId in ipairs(drivers) do
        local queueKey = 'rideflow:driver_offers:' .. driverId
        local offerKey = driverId .. ':' .. ARGV[1]

        redis.call('ZREM', queueKey, ARGV[1])

        local offerData = redis.call('HGET', KEYS[2], offerKey)
        if offerData then
          local offer = cjson.decode(offerData)

          if offer.status == 'pending' then
            offer.status = 'expired'
            offer.expiredAt = now
            redis.call('HSET', KEYS[2], offerKey, cjson.encode(offer))

            local rejectionKey = 'rideflow:driver_rejections:' .. driverId
            redis.call('SADD', rejectionKey, ARGV[1])
            redis.call('EXPIRE', rejectionKey, 2592000)

            expiredCount = expiredCount + 1
          end
        end
      end

      return expiredCount
    `;

    const result = await this.redis.eval(
      script,
      3,
      'rideflow:rides',
      'rideflow:offers',
      `rideflow:ride_offered_drivers:${rideId}`,
      rideId,
      String(Date.now())
    );

    return Number(result);
  }

  async getDriverRideOffers(
    driverId: string
  ): Promise<Array<Ride & { offerExpiresAt: number }>> {
    const queueKey = `rideflow:driver_offers:${driverId}`;
    const now = Date.now();

    const expiredIds = await this.redis.zrangebyscore(queueKey, '-inf', now);
    for (const rideId of expiredIds) {
      const offerKey = `${driverId}:${rideId}`;
      const data = await this.redis.hget('rideflow:offers', offerKey);
      if (data) {
        const offer = JSON.parse(data);
        if (offer.status === 'pending') {
          offer.status = 'expired';
          await this.redis.hset('rideflow:offers', offerKey, JSON.stringify(offer));

          const rejectionKey = `rideflow:driver_rejections:${driverId}`;
          await this.redis.sadd(rejectionKey, rideId);
          await this.redis.expire(rejectionKey, 2592000);
        }
      }
    }
    if (expiredIds.length) {
      await this.redis.zremrangebyscore(queueKey, '-inf', now);
    }

    const rideIds = await this.redis.zrange(queueKey, 0, 4);
    const results: Array<Ride & { offerExpiresAt: number }> = [];

    for (const rideId of rideIds) {
      const [offerData, ride] = await Promise.all([
        this.redis.hget('rideflow:offers', `${driverId}:${rideId}`),
        this.getRide(rideId),
      ]);

      if (!offerData || !ride || ride.status !== 'requested') {
        await this.redis.zrem(queueKey, rideId);
        continue;
      }

      const offer = JSON.parse(offerData);
      if (offer.status !== 'pending' || offer.expiresAt <= now) {
        await this.redis.zrem(queueKey, rideId);
        continue;
      }

      results.push({ ...ride, offerExpiresAt: offer.expiresAt });
    }

    return results;
  }

  async getRideOffersForRider(
    riderId: string
  ): Promise<Array<{
    rideId: string;
    ride: Ride;
    driverId: string;
    offer: {
      driverId: string;
      rideId: string;
      createdAt: number;
      expiresAt: number;
      status: 'pending' | 'expired';
    };
  }>> {
    const rides = await this.getRidesByRider(riderId);
    const results: Array<{
      rideId: string;
      ride: Ride;
      driverId: string;
      offer: {
        driverId: string;
        rideId: string;
        createdAt: number;
        expiresAt: number;
        status: 'pending' | 'expired';
      };
    }> = [];

    for (const ride of rides) {
      const driverIds = await this.redis.smembers(
        `rideflow:ride_offered_drivers:${ride.id}`
      );

      for (const driverId of driverIds) {
        const offerData = await this.redis.hget(
          'rideflow:offers',
          `${driverId}:${ride.id}`
        );
        if (offerData) {
          const offer = JSON.parse(offerData);
          results.push({
            rideId: ride.id,
            ride,
            driverId,
            offer,
          });
        }
      }
    }

    return results;
  }

  async rejectRideOffer(driverId: string, rideId: string): Promise<boolean> {
    const script = `
      local offerData = redis.call('HGET', KEYS[1], ARGV[1])
      if not offerData then return 0 end
      local offer = cjson.decode(offerData)
      if offer.status ~= 'pending' then return 0 end

      offer.status = 'rejected'
      offer.rejectedAt = tonumber(ARGV[2])
      redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(offer))
      redis.call('ZREM', KEYS[2], ARGV[3])
      redis.call('SADD', KEYS[3], ARGV[3])
      redis.call('EXPIRE', KEYS[3], 2592000)
      return 1
    `;

    const result = await this.redis.eval(
      script,
      3,
      'rideflow:offers',
      `rideflow:driver_offers:${driverId}`,
      `rideflow:driver_rejections:${driverId}`,
      `${driverId}:${rideId}`,
      String(Date.now()),
      rideId
    );

    return Number(result) === 1;
  }

  async acceptRideOffer(
    driverId: string,
    rideId: string,
    driverName: string
  ): Promise<{
    status:
      | 'accepted'
      | 'not_available'
      | 'active_ride'
      | 'offer_missing'
      | 'not_driver'
      | 'driver_offline'
      | 'driver_suspended'
      | 'capacity_unverified'
      | 'capacity_exceeded';
    ride?: Ride;
  }> {
    const script = `
      local rideData = redis.call('HGET', KEYS[1], ARGV[1])
      if not rideData then return 'not_available' end

      local driverData = redis.call('HGET', KEYS[4], ARGV[3])
      if not driverData then return 'not_driver' end
      local driver = cjson.decode(driverData)

      if driver.role ~= 'driver' then return 'not_driver' end
      if driver.suspended == true then return 'driver_suspended' end
      if driver.isOnline ~= true then return 'driver_offline' end

      local capacity = tonumber(
        driver.vehicleInfo and driver.vehicleInfo.seatingCapacity
      )
      if not capacity or capacity < 1 or capacity > 8
        or capacity % 1 ~= 0 then
        return 'capacity_unverified'
      end

      local offerData = redis.call('HGET', KEYS[2], ARGV[2])
      if not offerData then return 'offer_missing' end
      local offer = cjson.decode(offerData)
      if offer.status ~= 'pending' or tonumber(offer.expiresAt) <= tonumber(ARGV[4]) then
        return 'offer_missing'
      end

      local ride = cjson.decode(rideData)
      if ride.status ~= 'requested' then return 'not_available' end

      local passengerCount = tonumber(ride.passengerCount) or
        (1 + (tonumber(ride.additionalPassengers) or 0))

      -- Calculate remaining capacity from all active rides already assigned
      -- to this driver.
      local remainingCapacity = capacity

      local allRides = redis.call('HVALS', KEYS[1])
      for _, data in ipairs(allRides) do
        local existing = cjson.decode(data)
        if existing.driverId == ARGV[3]
          and existing.status ~= 'completed'
          and existing.status ~= 'cancelled' then
          -- Private rides are exclusive: a driver with an active Private ride
          -- cannot accept any new offers.
          if existing.rideType == 'private' then
            return 'active_ride'
          end

          -- Shared rides can be combined: subtract their passenger count
          -- from the driver's remaining capacity.
          local existingPassengerCount = tonumber(existing.passengerCount) or
            (1 + (tonumber(existing.additionalPassengers) or 0))
          remainingCapacity = remainingCapacity - existingPassengerCount
        end
      end

      if passengerCount > remainingCapacity then
        return 'capacity_exceeded'
      end

      ride.driverId = ARGV[3]
      ride.driverName = ARGV[5]
      ride.status = 'accepted'
      ride.acceptedAt = ARGV[6]
      redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(ride))

      -- Withdraw every other pending offer from the winning driver's queue.
      local ownQueue = 'rideflow:driver_offers:' .. ARGV[3]
      local ownRideIds = redis.call('ZRANGE', ownQueue, 0, -1)
      for _, ownRideId in ipairs(ownRideIds) do
        redis.call('ZREM', ownQueue, ownRideId)
        local ownOfferKey = ARGV[3] .. ':' .. ownRideId
        local ownOfferData = redis.call('HGET', KEYS[2], ownOfferKey)
        if ownOfferData then
          local ownOffer = cjson.decode(ownOfferData)
          if ownOffer.status == 'pending' then
            ownOffer.status = 'withdrawn'
            redis.call('HSET', KEYS[2], ownOfferKey, cjson.encode(ownOffer))
          end
        end
      end

      local drivers = redis.call('SMEMBERS', KEYS[3])
      for _, otherDriverId in ipairs(drivers) do
        local otherQueue = 'rideflow:driver_offers:' .. otherDriverId
        redis.call('ZREM', otherQueue, ARGV[1])
        local otherOfferKey = otherDriverId .. ':' .. ARGV[1]
        local otherOfferData = redis.call('HGET', KEYS[2], otherOfferKey)
        if otherOfferData then
          local otherOffer = cjson.decode(otherOfferData)
          if otherOffer.status == 'pending' then
            otherOffer.status = 'withdrawn'
            redis.call('HSET', KEYS[2], otherOfferKey, cjson.encode(otherOffer))
          end
        end
      end

      return 'accepted'
    `;

    const result = String(await this.redis.eval(
      script,
      4,
      'rideflow:rides',
      'rideflow:offers',
      `rideflow:ride_offered_drivers:${rideId}`,
      'rideflow:users',
      rideId,
      `${driverId}:${rideId}`,
      driverId,
      String(Date.now()),
      driverName,
      new Date().toISOString()
    ));

    if (result !== 'accepted') {
      return {
        status: result as
          | 'not_available'
          | 'active_ride'
          | 'offer_missing'
          | 'not_driver'
          | 'driver_offline'
          | 'driver_suspended'
          | 'capacity_unverified'
          | 'capacity_exceeded',
      };
    }

    const ride = await this.getRide(rideId);
    return ride ? { status: 'accepted', ride } : { status: 'not_available' };
  }

  async createEvent(event: Omit<WebhookEvent, 'id' | 'createdAt'>): Promise<WebhookEvent> {
    const id = randomUUID();
    const newEvent: WebhookEvent = { ...event, id, createdAt: new Date().toISOString() };
    await this.redis.hset('rideflow:events', id, JSON.stringify(newEvent));
    return newEvent;
  }

  async getEventsByUser(userId: string): Promise<WebhookEvent[]> {
    const data = await this.redis.hvals('rideflow:events');
    return data
      .map(d => JSON.parse(d) as WebhookEvent)
      .filter(e => e.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);
  }

  async markEventRead(eventId: string): Promise<void> {
    const data = await this.redis.hget('rideflow:events', eventId);
    if (data) {
      const event = JSON.parse(data) as WebhookEvent;
      event.read = true;
      await this.redis.hset('rideflow:events', eventId, JSON.stringify(event));
    }
  }

  async getConfig(): Promise<PlatformConfig> {
    return this.getConfigInternal();
  }

  async updateConfig(updates: Partial<PlatformConfig>): Promise<PlatformConfig> {
    const current = await this.getConfigInternal();
    const updated = { ...current, ...updates };
    const groupDiscount = Number(updated.groupDiscountPercent);
    updated.groupDiscountPercent = Number.isFinite(groupDiscount)
      ? Math.max(0, Math.min(90, groupDiscount))
      : 20;

    const discount = Number(updated.sharedRideDiscountPercent);
    updated.sharedRideDiscountPercent = Number.isFinite(discount)
      ? Math.max(0, Math.min(90, discount))
      : 15;

    const dispatchFields = [
      'dispatchInitialRadiusKm',
      'dispatchRadiusIncrementKm',
      'dispatchMaximumRadiusKm',
      'dispatchOfferWindowSeconds',
    ] as const;

    for (const field of dispatchFields) {
      const value = Number(updated[field]);

      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${field} must be a positive number`);
      }

      updated[field] = value;
    }

    if (!Number.isInteger(updated.dispatchOfferWindowSeconds)) {
      throw new Error('dispatchOfferWindowSeconds must be a whole number');
    }

    if (updated.dispatchMaximumRadiusKm < updated.dispatchInitialRadiusKm) {
      throw new Error('Maximum dispatch radius cannot be smaller than the initial radius');
    }

    await this.redis.set('rideflow:config', JSON.stringify({
      ...updated,
      fareModelVersion: FARE_MODEL_VERSION,
    }));
    return updated;
  }
}

export const storage = new RedisStorage();
