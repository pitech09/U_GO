import { z } from "zod";

export type UserRole = 'rider' | 'driver' | 'admin';

export interface User {
  id: string;
  username: string;
  password: string;
  role: UserRole;
  fullName: string;
  phone: string;
  createdAt: string;
  isOnline?: boolean;
  suspended?: boolean;
  currentLocation?: { lat: number; lng: number };
  vehicleInfo?: {
    make: string;
    model: string;
    year: string;
    color: string;
    plate: string;
  };
  rating?: number;
  totalRides?: number;
  totalEarnings?: number;
}

export interface PlatformConfig {
  baseFare: number;
  perMile: number;
  perMinute: number;
  driverSharePercent: number;
  minimumFare: number;
  surgePricing: boolean;
  surgeMultiplier: number;
}

export type RideStatus = 'requested' | 'accepted' | 'arriving' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';

export interface Ride {
  id: string;
  riderId: string;
  driverId?: string;
  status: RideStatus;
  pickup: {
    lat: number;
    lng: number;
    address: string;
  };
  dropoff: {
    lat: number;
    lng: number;
    address: string;
  };
  fare?: {
    baseFare: number;
    distanceFare: number;
    timeFare: number;
    totalFare: number;
    driverEarnings: number;
    platformFee: number;
  };
  distance?: number;
  duration?: number;
  createdAt: string;
  acceptedAt?: string;
  arrivedAt?: string;
  startedAt?: string;
  completedAt?: string;
  riderName?: string;
  driverName?: string;
  review?: {
    rating: number;
    comment?: string;
    createdAt: string;
  };
}

export interface WebhookEvent {
  id: string;
  type: 'ride_requested' | 'ride_accepted' | 'driver_arriving' | 'driver_arrived' | 'ride_started' | 'ride_completed' | 'ride_cancelled';
  rideId: string;
  userId: string;
  data: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

export const registerSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(4),
  fullName: z.string().min(2),
  phone: z.string().min(7),
  role: z.enum(['rider', 'driver']),
  vehicleInfo: z.object({
    make: z.string(),
    model: z.string(),
    year: z.string(),
    color: z.string(),
    plate: z.string(),
  }).optional(),
});

export const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const requestRideSchema = z.object({
  pickup: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }),
  dropoff: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }),
});

export const updateLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

export type InsertUser = z.infer<typeof registerSchema>;
