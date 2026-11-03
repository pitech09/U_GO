import { randomUUID } from "crypto";
import Redis from "ioredis";
import type { User, Ride, WebhookEvent, UserRole, PlatformConfig } from "@shared/schema";

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

  createEvent(event: Omit<WebhookEvent, 'id' | 'createdAt'>): Promise<WebhookEvent>;
  getEventsByUser(userId: string): Promise<WebhookEvent[]>;
  markEventRead(eventId: string): Promise<void>;

  getConfig(): Promise<PlatformConfig>;
  updateConfig(updates: Partial<PlatformConfig>): Promise<PlatformConfig>;

  initialize(): Promise<void>;
}

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

const DEFAULT_CONFIG: PlatformConfig = {
  baseFare: 2.50,
  perMile: 1.75,
  perMinute: 0.35,
  driverSharePercent: 82,
  minimumFare: 5.00,
  surgePricing: false,
  surgeMultiplier: 1.0,
};

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
    return all.filter(u => (u.role === 'driver' || u.role === 'admin') && u.isOnline && !u.suspended);
  }

  private async getConfigInternal(): Promise<PlatformConfig> {
    const data = await this.redis.get('rideflow:config');
    if (!data) return { ...DEFAULT_CONFIG };
    return JSON.parse(data);
  }

  private async calculateFare(distanceMiles: number): Promise<{
    baseFare: number;
    distanceFare: number;
    timeFare: number;
    totalFare: number;
    driverEarnings: number;
    platformFee: number;
  }> {
    const config = await this.getConfigInternal();
    const { baseFare, perMile, perMinute, driverSharePercent, minimumFare, surgePricing, surgeMultiplier } = config;
    const estimatedMinutes = distanceMiles * 3;
    const distanceFare = distanceMiles * perMile;
    const timeFare = estimatedMinutes * perMinute;
    let totalFare = Math.max(baseFare + distanceFare + timeFare, minimumFare);
    if (surgePricing) totalFare *= surgeMultiplier;
    const driverPercent = driverSharePercent / 100;
    return {
      baseFare: Math.round(baseFare * 100) / 100,
      distanceFare: Math.round(distanceFare * 100) / 100,
      timeFare: Math.round(timeFare * 100) / 100,
      totalFare: Math.round(totalFare * 100) / 100,
      driverEarnings: Math.round(totalFare * driverPercent * 100) / 100,
      platformFee: Math.round(totalFare * (1 - driverPercent) * 100) / 100,
    };
  }

  async createRide(ride: Omit<Ride, 'id' | 'createdAt'>): Promise<Ride> {
    const id = randomUUID();
    const distance = calculateDistance(
      ride.pickup.lat, ride.pickup.lng,
      ride.dropoff.lat, ride.dropoff.lng
    );
    const fare = await this.calculateFare(distance);
    const newRide: Ride = {
      ...ride,
      id,
      createdAt: new Date().toISOString(),
      distance: Math.round(distance * 10) / 10,
      duration: Math.round(distance * 3),
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
    return all.filter(r => !['completed', 'cancelled'].includes(r.status));
  }

  async getAllRides(): Promise<Ride[]> {
    const data = await this.redis.hvals('rideflow:rides');
    return data
      .map(d => JSON.parse(d) as Ride)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
    await this.redis.set('rideflow:config', JSON.stringify(updated));
    return updated;
  }
}

export const storage = new RedisStorage();
