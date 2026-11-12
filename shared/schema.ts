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
    seatingCapacity?: number;
  };
  rating?: number;
  totalRides?: number;
  totalEarnings?: number;
}

export type RideType = 'private' | 'shared';

export type PaymentMethod = 'cash' | 'mpesa' | 'ecocash';
export type PaymentStatus = 'pending_cash' | 'pending_verification' | 'paid' | 'rejected';

export interface RidePayment {
  method: PaymentMethod;
  status: PaymentStatus;
  transactionReference?: string;
  proofImage?: string;
  submittedAt: string;
  verifiedAt?: string;
  verifiedBy?: string;
}

export type PassengerPricingMode = 'fixed' | 'multiplier';

export interface PlatformConfig {
  baseFare: number;
  perKm: number;
  perMinute: number;
  driverSharePercent: number;
  minimumFare: number;
  surgePricing: boolean;
  surgeMultiplier: number;
  sharedRideDiscountPercent: number;
  groupDiscountPercent: number;
  passengerPricingMode: PassengerPricingMode;
  additionalPassengerFee: number;
  additionalPassengerMultiplier: number;
  dispatchInitialRadiusKm: number;
  dispatchRadiusIncrementKm: number;
  dispatchMaximumRadiusKm: number;
  dispatchOfferWindowSeconds: number;
}

export type RideStatus = 'requested' | 'accepted' | 'arriving' | 'arrived' | 'in_progress' | 'completed' | 'cancelled' | 'no_drivers_available';

export interface Ride {
  id: string;
  riderId: string;
  driverId?: string;
  status: RideStatus;
  rideType?: RideType;
  additionalPassengers?: number;
  passengerCount?: number;
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
    passengerFare?: number;
    sharedDiscount?: number;
    sharedRideDiscountPercent?: number;
    groupDiscountPercent?: number;
    totalFare: number;
    driverEarnings: number;
    platformFee: number;
  };
  payment?: RidePayment;
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
  type: 'ride_requested' | 'ride_accepted' | 'driver_arriving' | 'driver_arrived' | 'ride_started' | 'ride_completed' | 'ride_cancelled' | 'no_drivers_available';
  rideId: string;
  userId: string;
  data: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

export const vehicleInfoSchema = z.object({
  make: z.string().trim().min(1),
  model: z.string().trim().min(1),
  year: z.string().trim().min(1),
  color: z.string().trim().min(1),
  plate: z.string().trim().min(1),
  seatingCapacity: z.number().int().min(1).max(8),
});

export const registerSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(4),
  fullName: z.string().min(2),
  phone: z.string().min(7),
  role: z.enum(['rider', 'driver']),
  vehicleInfo: vehicleInfoSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.role === 'driver' && !data.vehicleInfo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['vehicleInfo'],
      message: 'Vehicle details and passenger seating capacity are required for drivers.',
    });
  }
});

export const updateVehicleSchema = z.object({
  vehicleInfo: vehicleInfoSchema,
});

export const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const coordinateSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

export const requestRideSchema = z.object({
  rideType: z.enum(['private', 'shared']).default('private'),
  additionalPassengers: z.number().int().min(0).max(7).default(0),
  pickup: coordinateSchema.extend({
    address: z.string().trim().min(1),
  }),
  dropoff: coordinateSchema.extend({
    address: z.string().trim().min(1),
  }),
  paymentMethod: z.enum(['cash', 'mpesa', 'ecocash']).optional(),
  paymentReference: z.string().trim().max(80).optional(),
  paymentProofImage: z.string()
    .max(6_000_000)
    .regex(/^data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/, 'Payment proof must be a PNG or JPEG image.')
    .optional(),
});

export const updateLocationSchema = coordinateSchema;

export type InsertUser = z.infer<typeof registerSchema>;
