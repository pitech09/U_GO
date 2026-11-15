import { z } from "zod";

export type UserRole = 'rider' | 'driver' | 'admin';

export type KycStatus = 'not_submitted' | 'pending' | 'approved' | 'rejected';

export interface DriverKyc {
  status: KycStatus;
  idDocumentType?: 'national_id' | 'passport' | 'drivers_license';
  idDocumentImage?: string;
  driverLicenseImage?: string;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
}

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
  vehiclePhotos?: string[];
  kyc?: DriverKyc;
  rating?: number;
  totalRides?: number;
  totalEarnings?: number;
}

export type RideType = 'private' | 'shared';
export type RideServiceType = 'ride' | 'parcel';

export interface ParcelDetails {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  photo?: string;
  description?: string;
  seatUnits?: number;
}

export type PaymentMethod = 'cash' | 'mpesa' | 'ecocash';
export type PaymentStatus = 'pending_cash' | 'pending_verification' | 'pending_provider' | 'paid' | 'rejected' | 'failed';

export interface RidePayment {
  method: PaymentMethod;
  status: PaymentStatus;
  providerTransactionId?: string;
  providerConversationId?: string;
  thirdPartyConversationId?: string;
  phone?: string;
  amount?: number;
  transactionReference?: string;
  proofImage?: string;
  submittedAt: string;
  verifiedAt?: string;
  verifiedBy?: string;
  reversedAt?: string;
  reversalTransactionId?: string;
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

export type RideStatus = 'scheduled' | 'requested' | 'accepted' | 'arriving' | 'arrived' | 'in_progress' | 'completed' | 'cancelled' | 'no_drivers_available';

export interface Ride {
  id: string;
  riderId: string;
  driverId?: string;
  status: RideStatus;
  rideType?: RideType;
  serviceType?: RideServiceType;
  additionalPassengers?: number;
  passengerCount?: number;
  parcel?: ParcelDetails;
  scheduledAt?: string;
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
    parcelFare?: number;
    parcelMultiplier?: number;
  };
  payment?: RidePayment;
  distance?: number;
  duration?: number;
  createdAt: string;
  acceptedAt?: string;
  arrivedAt?: string;
  startedAt?: string;
  completedAt?: string;
  cancellationPaymentRequired?: boolean;
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
  type: 'ride_requested' | 'ride_accepted' | 'driver_arriving' | 'driver_arrived' | 'ride_started' | 'ride_completed' | 'ride_cancelled' | 'no_drivers_available' | 'payment_pending' | 'payment_paid' | 'payment_failed';
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

const privateImageSchema = z.string()
  .max(4_000_000)
  .regex(/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/, 'Image must be a PNG, JPEG, or WebP data URL.');

export const vehiclePhotosSchema = z.object({
  photos: z.array(privateImageSchema).min(1).max(5),
}).superRefine((data, ctx) => {
  if (data.photos.reduce((total, photo) => total + photo.length, 0) > 8_000_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['photos'], message: 'Vehicle photos are too large. Choose smaller images.' });
  }
});

export const driverKycSchema = z.object({
  idDocumentType: z.enum(['national_id', 'passport', 'drivers_license']),
  idDocumentImage: privateImageSchema,
  driverLicenseImage: privateImageSchema.optional(),
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
  serviceType: z.enum(['ride', 'parcel']).default('ride'),
  rideType: z.enum(['private', 'shared']).default('private'),
  additionalPassengers: z.number().int().min(0).max(7).default(0),
  passengerCount: z.number().int().min(1).max(8).default(1),
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
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  parcel: z.object({
    weightKg: z.number().positive().max(100),
    lengthCm: z.number().positive().max(250),
    widthCm: z.number().positive().max(250),
    heightCm: z.number().positive().max(250),
    photo: z.string().max(6_000_000).regex(/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/),
    description: z.string().trim().max(200).optional(),
  }).optional(),
}).superRefine((data, ctx) => {
  if (data.serviceType === 'parcel' && !data.parcel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parcel'], message: 'Parcel weight, size, and photo details are required.' });
  }
  if (data.serviceType === 'ride' && data.passengerCount !== 1 + data.additionalPassengers) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passengerCount'], message: 'Passenger count does not match additional passengers.' });
  }
  if (data.scheduledAt && new Date(data.scheduledAt).getTime() < Date.now() + 5 * 60 * 1000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledAt'], message: 'Scheduled bookings must be at least 5 minutes from now.' });
  }
});

export const updateLocationSchema = coordinateSchema;

export type InsertUser = z.infer<typeof registerSchema>;
