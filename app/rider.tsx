import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform, TextInput, Image,
  ActivityIndicator, Dimensions, ScrollView, Linking, Keyboard,
} from 'react-native';
import { router } from 'expo-router';
import MapView, {
  Marker,
  Polyline,
  PROVIDER_DEFAULT,
  CartoTileLayer,
} from '@/components/MapView';
import AppModal, { useAppModal } from '@/components/AppModal';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest, authenticatedFetch, getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';
import Animated, { FadeInDown, FadeInUp, SlideInDown, FadeIn } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { Ride, User } from '@shared/schema';
import { calculateDistance } from '@shared/distance';
import { roundCashFare } from '@shared/fare';
import { playRideUpdateSound } from '@/lib/sound-notifications';

const { width, height } = Dimensions.get('window');
const ASPECT_RATIO = width / height;
const LATITUDE_DELTA = 0.015;
const LONGITUDE_DELTA = LATITUDE_DELTA * ASPECT_RATIO;

type RiderPhase = 'idle' | 'selecting_dropoff' | 'confirming' | 'waiting' | 'matched' | 'riding' | 'completed';

interface NearbyDriver {
  id: string;
  fullName: string;
  rating: number;
  currentLocation: { lat: number; lng: number };
  vehicleInfo?: { make: string; model: string; color: string; plate: string };
  distance: number;
}

export default function RiderScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const mapRef = useRef<MapView>(null);

  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<RiderPhase>('idle');
  const [dropoffAddress, setDropoffAddress] = useState('');
  const [dropoffCoord, setDropoffCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [pickupAddress, setPickupAddress] = useState('Current Location');
  const [nearbyDrivers, setNearbyDrivers] = useState<NearbyDriver[]>([]);
  const [fareEstimate, setFareEstimate] = useState<any>(null);
  const [activeRide, setActiveRide] = useState<Ride | null>(null);
  const [scheduledRides, setScheduledRides] = useState<Ride[]>([]);
  const [driverInfo, setDriverInfo] = useState<any>(null);
  const [driverEtaMinutes, setDriverEtaMinutes] = useState<number | null>(null);
  const [routeCoordinates, setRouteCoordinates] = useState<Array<{ latitude: number; longitude: number }>>([]);
  const [loading, setLoading] = useState(false);
  const [addressInput, setAddressInput] = useState('');
  const [addressSearching, setAddressSearching] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<Array<{ display_name: string; lat: string; lon: string }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [rideType, setRideType] = useState<'private' | 'shared'>('private');
  const [additionalPassengers, setAdditionalPassengers] = useState(0);
  const [serviceType, setServiceType] = useState<'ride' | 'parcel'>('ride');
  const [parcelWeight, setParcelWeight] = useState('');
  const [parcelLength, setParcelLength] = useState('');
  const [parcelWidth, setParcelWidth] = useState('');
  const [parcelHeight, setParcelHeight] = useState('');
  const [parcelDescription, setParcelDescription] = useState('');
  const [parcelPhoto, setParcelPhoto] = useState<string | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(() => new Date(Date.now() + 60 * 60 * 1000));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'mpesa' | 'ecocash'>('cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentProofImage, setPaymentProofImage] = useState<string | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);

  const phaseRef = useRef<RiderPhase>(phase);
  const activeRideRef = useRef<Ride | null>(activeRide);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const eventsInitializedRef = useRef(false);
  const activeRideRequestRef = useRef(false);
  const locationRef = useRef(location);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { activeRideRef.current = activeRide; }, [activeRide]);
  useEffect(() => { locationRef.current = location; }, [location]);

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKeyboardHeight(e.endCoordinates.height)
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardHeight(0)
    );
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const { showAlert, showActionSheet, modalProps } = useAppModal();

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  useEffect(() => {
    requestLocation();
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    checkActiveRide();
    fetchScheduledRides();
    pollUserEvents();

    const interval = setInterval(() => {
      checkActiveRide();
      fetchScheduledRides();
      pollUserEvents();
    }, 5000);

    return () => clearInterval(interval);
  }, [user?.id]);

  const fetchScheduledRides = async () => {
    if (!user?.id) return;
    try {
      const res = await apiRequest('GET', `/api/rides/rider/${user.id}`);
      if (!res.ok) return;
      const rides = await res.json() as Ride[];
      setScheduledRides(rides.filter(ride => ride.scheduledAt && !['completed', 'cancelled', 'no_drivers_available'].includes(ride.status)));
    } catch {}
  };

  useEffect(() => {
    if (location) {
      fetchNearbyDrivers();
      updateServerLocation();
      const interval = setInterval(fetchNearbyDrivers, 10000);
      return () => clearInterval(interval);
    }
  }, [location]);

  const requestLocation = async () => {
    if (Platform.OS === 'web') {
      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
            setPermissionStatus('granted');
          },
          () => {
            setLocation({ lat: 37.7749, lng: -122.4194 });
            setPermissionStatus('granted');
          }
        );
      } catch {
        setLocation({ lat: 37.7749, lng: -122.4194 });
        setPermissionStatus('granted');
      }
      return;
    }

    const { status } = await Location.requestForegroundPermissionsAsync();
    setPermissionStatus(status);
    if (status !== 'granted') return;

    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });

    try {
      const geocode = await Location.reverseGeocodeAsync({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      });
      if (geocode.length > 0) {
        const g = geocode[0];
        setPickupAddress(`${g.street || ''} ${g.city || ''}`.trim() || 'Current Location');
      }
    } catch {}
  };

  const updateServerLocation = async () => {
    if (!user?.id || !location) return;
    try {
      await apiRequest('PUT', `/api/user/${user.id}/location`, location);
    } catch {}
  };

  const fetchNearbyDrivers = async () => {
    const loc = locationRef.current;
    if (!loc) return;
    try {
      const baseUrl = getApiUrl();
      const excludeParam = (user?.id && user?.role !== 'admin') ? `&exclude=${user.id}` : '';
      const url = new URL(`/api/drivers/nearby?lat=${loc.lat}&lng=${loc.lng}&radius=15${excludeParam}`, baseUrl);
      const res = await authenticatedFetch(url.toString(), { cache: 'no-store' });
      const data = await res.json();
      setNearbyDrivers(data);
    } catch {}
  };

  const checkActiveRide = async () => {
    if (!user?.id) return;
    if (activeRideRequestRef.current) return;
    activeRideRequestRef.current = true;
    try {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/rides/rider/${user.id}/active`, baseUrl);
      const res = await authenticatedFetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.id) {
        setActiveRide(data);
        if (data.status === 'requested' || data.status === 'scheduled') setPhase('waiting');
        else if (data.status === 'accepted' || data.status === 'arriving') {
          setPhase('matched');
          if (data.driverId) fetchDriverInfo(data.driverId);
        }
        else if (data.status === 'arrived' || data.status === 'in_progress') {
          setPhase('riding');
          if (data.driverId) fetchDriverInfo(data.driverId);
        }
        else if (data.status === 'completed') {
          if (data.review) {
            setReviewSubmitted(true);
            setActiveRide(null);
            setDriverInfo(null);
            setPhase('idle');
          } else {
            setReviewSubmitted(false);
            setPhase('completed');
          }
        }
      } else {
        const currentPhase = phaseRef.current;
        const currentRide = activeRideRef.current;
        if (currentRide?.status === 'cancelled' && currentRide.cancellationPaymentRequired) {
          // Cancellation charges are paid after the ride leaves the active
          // endpoint; do not let polling replace this payment screen with a
          // completed-ride review screen.
          setActiveRide(currentRide);
          setPhase('matched');
          return;
        }
        if (currentPhase === 'waiting' || currentPhase === 'matched' || currentPhase === 'riding') {
          if (currentRide) {
            setActiveRide(currentRide);
            setPhase('completed');
          } else {
            setPhase('idle');
          }
        }
      }
    } catch {
      // A temporary network failure is not evidence that the ride completed
      // or was cancelled. Leave the last backend-confirmed state visible.
    } finally {
      activeRideRequestRef.current = false;
    }
  };

  const pollUserEvents = async () => {
    if (!user?.id) return;

    try {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/events/${user.id}`, baseUrl);
      const res = await authenticatedFetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) return;

      const events = await res.json();
      if (!Array.isArray(events)) return;

      if (!eventsInitializedRef.current) {
        events.forEach((event: any) => seenEventIdsRef.current.add(event.id));
        eventsInitializedRef.current = true;
        return;
      }

      const soundEvents = new Set([
        'ride_accepted',
        'driver_arriving',
        'driver_arrived',
        'ride_started',
        'ride_completed',
        'ride_cancelled',
      ]);

      for (const event of [...events].reverse()) {
        if (seenEventIdsRef.current.has(event.id)) continue;
        seenEventIdsRef.current.add(event.id);

        if (soundEvents.has(event.type)) {
          playRideUpdateSound(event.type);
        }
      }
    } catch {}
  };

  const fetchDriverInfo = async (driverId: string) => {
    try {
      const res = await apiRequest('GET', `/api/user/${driverId}`);
      const data = await res.json();
      setDriverInfo(data);
    } catch {}
  };

  const activeDriverPosition = driverInfo?.currentLocation
    || nearbyDrivers.find((driver) => driver.id === activeRide?.driverId)?.currentLocation
    || null;

  useEffect(() => {
    if (!activeRide || !activeDriverPosition || activeRide.status === 'arrived') {
      setDriverEtaMinutes(null);
      return;
    }

    const destination = activeRide.status === 'in_progress'
      ? activeRide.dropoff
      : activeRide.pickup;
    const distanceKm = calculateDistance(
      activeDriverPosition.lat,
      activeDriverPosition.lng,
      destination.lat,
      destination.lng,
    );

    // Keep the ETA consistent with the fare model's average urban speed.
    setDriverEtaMinutes(Math.max(1, Math.ceil(distanceKm * (3 / 1.609344))));
  }, [activeRide?.id, activeRide?.status, activeRide?.pickup, activeRide?.dropoff, activeDriverPosition?.lat, activeDriverPosition?.lng]);

  useEffect(() => {
    const waypoints = activeRide && activeDriverPosition
      ? [
          activeDriverPosition,
          ...(activeRide.status === 'in_progress' ? [] : [activeRide.pickup]),
          activeRide.dropoff,
        ]
      : location && dropoffCoord
        ? [location, dropoffCoord]
        : [];

    if (waypoints.length < 2) {
      setRouteCoordinates([]);
      return;
    }

    let cancelled = false;
    const fetchRoute = async () => {
      try {
        const res = await apiRequest('POST', '/api/routes/route', { waypoints });
        const data = await res.json();
        if (!cancelled && Array.isArray(data.coordinates)) {
          setRouteCoordinates(data.coordinates);
        }
      } catch {
        if (!cancelled) setRouteCoordinates([]);
      }
    };

    fetchRoute();
    return () => { cancelled = true; };
  }, [location?.lat, location?.lng, dropoffCoord?.lat, dropoffCoord?.lng, activeRide?.id, activeRide?.status, activeRide?.pickup.lat, activeRide?.pickup.lng, activeRide?.dropoff.lat, activeRide?.dropoff.lng, activeDriverPosition?.lat, activeDriverPosition?.lng]);

  const handleMapPress = (e: any) => {
    if (phase !== 'selecting_dropoff') return;
    const coord = e.nativeEvent.coordinate;
    setDropoffCoord({ lat: coord.latitude, lng: coord.longitude });

    if (Platform.OS !== 'web') {
      (async () => {
        try {
          const geocode = await Location.reverseGeocodeAsync({
            latitude: coord.latitude,
            longitude: coord.longitude,
          });
          if (geocode.length > 0) {
            const g = geocode[0];
            setDropoffAddress(`${g.street || ''} ${g.city || ''}`.trim() || 'Selected Location');
          } else {
            setDropoffAddress('Selected Location');
          }
        } catch {
          setDropoffAddress('Selected Location');
        }
      })();
    } else {
      reverseGeocodeWeb(coord.latitude, coord.longitude);
    }
  };

  const reverseGeocodeWeb = async (lat: number, lng: number) => {
    try {
      const res = await apiRequest(
        'GET',
        `/api/geocode/reverse?lat=${lat}&lon=${lng}`
      );
      const data = await res.json();

      if (data.display_name) {
        const parts = data.display_name.split(',');
        setDropoffAddress(parts.slice(0, 3).join(',').trim());
      } else {
        setDropoffAddress(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      }
    } catch {
      setDropoffAddress(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    }
  };

  const handleAddressInputChange = useCallback((text: string) => {
    setAddressInput(text);
    setAddressSuggestions([]);
    setShowSuggestions(false);
  }, []);

  const selectSuggestion = useCallback((suggestion: { display_name: string; lat: string; lon: string }) => {
    const lat = parseFloat(suggestion.lat);
    const lng = parseFloat(suggestion.lon);
    const parts = suggestion.display_name.split(',');
    const shortName = parts.slice(0, 3).join(',').trim();
    setAddressInput(shortName);
    setDropoffCoord({ lat, lng });
    setDropoffAddress(shortName);
    setShowSuggestions(false);
    setAddressSuggestions([]);
    Keyboard.dismiss();

    if (mapRef.current) {
      (mapRef.current as any).animateToRegion?.({
        latitude: lat,
        longitude: lng,
        latitudeDelta: LATITUDE_DELTA,
        longitudeDelta: LONGITUDE_DELTA,
      }, 500);
    }
  }, []);

  const searchAddress = async () => {
    const searchText = addressInput.trim();
    if (searchText.length < 3) {
      showAlert("Search", "Enter at least 3 characters.");
      return;
    }

    setAddressSearching(true);
    setShowSuggestions(false);
    setAddressSuggestions([]);

    try {
      const route = `/api/geocode/search?q=${encodeURIComponent(searchText)}`;
      const response = await apiRequest("GET", route);
      const results = await response.json();

      if (!Array.isArray(results) || results.length === 0) {
        showAlert("Not Found", "Address not found. Try a different search.");
        return;
      }

      setAddressSuggestions(results);
      setShowSuggestions(true);
    } catch (error) {
      console.error("U-GO destination search failed:", error);
      showAlert(
        "Search Error",
        error instanceof Error
          ? error.message
          : "Destination search failed. Please try again.",
      );
    } finally {
      setAddressSearching(false);
    }
  };

  const handleConfirmDropoff = async () => {
    if (!dropoffCoord) {
      showAlert('Destination required', 'Search for a destination or tap the map first.');
      return;
    }
    if (!location) {
      showAlert('Location unavailable', 'We cannot calculate the fare until your pickup location is available. Please enable location access and try again.');
      requestLocation();
      return;
    }
    setLoading(true);
    try {
      const baseUrl = getApiUrl();
      if (serviceType === 'parcel' && (!parcelPhoto || !parcelWeight || !parcelLength || !parcelWidth || !parcelHeight)) {
        showAlert('Parcel details required', 'Add a parcel photo, weight, and all three size estimates first.');
        return;
      }
      const parcelParams = serviceType === 'parcel'
        ? `&serviceType=parcel&parcelWeightKg=${parcelWeight}&parcelLengthCm=${parcelLength}&parcelWidthCm=${parcelWidth}&parcelHeightCm=${parcelHeight}`
        : '';
      const url = new URL(
        `/api/fare/estimate?pLat=${location.lat}&pLng=${location.lng}&dLat=${dropoffCoord.lat}&dLng=${dropoffCoord.lng}&rideType=${rideType}&additionalPassengers=${additionalPassengers}${parcelParams}`,
        baseUrl
      );
      const res = await authenticatedFetch(url.toString());
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        setFareEstimate(null);
        setPhase('selecting_dropoff');
        showAlert('Fare Error', body.message ?? `Request failed with status ${res.status}`);
        return;
      }
      const data = await res.json();
      setFareEstimate(data);
      setPhase('confirming');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (e: any) {
      console.error('U-GO fare estimate failed:', e);
      showAlert('Fare Error', e?.message || 'Could not get fare estimate. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestRide = async () => {
    if (!location || !dropoffCoord || !user?.id) return;
    let scheduledAt: string | undefined;
    if (scheduleEnabled) {
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now() + 5 * 60 * 1000) {
        showAlert('Invalid schedule', 'Choose a valid pickup time at least 5 minutes from now.');
        return;
      }
      scheduledAt = scheduledDate.toISOString();
    }
    setLoading(true);
    try {
      const res = await apiRequest('POST', '/api/rides', {
        riderId: user.id,
        pickup: { lat: location.lat, lng: location.lng, address: pickupAddress },
        dropoff: { lat: dropoffCoord.lat, lng: dropoffCoord.lng, address: dropoffAddress },
        rideType,
        serviceType,
        additionalPassengers,
        passengerCount: 1 + additionalPassengers,
        scheduledAt,
        parcel: serviceType === 'parcel' ? {
          weightKg: Number(parcelWeight), lengthCm: Number(parcelLength), widthCm: Number(parcelWidth), heightCm: Number(parcelHeight),
          photo: parcelPhoto, description: parcelDescription.trim() || undefined,
        } : undefined,
      });
      const ride = await res.json();
      if (ride.scheduledAt) {
        setActiveRide(null);
        setPhase('idle');
        await fetchScheduledRides();
        showAlert('Ride scheduled', `Your pickup is scheduled for ${new Date(ride.scheduledAt).toLocaleString()}. You can request another ride now.`);
      } else {
        setActiveRide(ride);
        setPhase('waiting');
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      showAlert('Error', e.message || 'Could not request ride');
    } finally {
      setLoading(false);
    }
  };

  const submitRidePayment = async () => {
    if (!activeRide?.id || !user?.id) return;
    if (paymentMethod !== 'cash' && !paymentReference.trim()) {
      showAlert('Payment reference required', 'Enter the M-Pesa or EcoCash transaction number after paying.');
      return;
    }

    setPaymentSubmitting(true);
    try {
      const updated = await apiRequest('PUT', `/api/rides/${activeRide.id}/payment`, {
        riderId: user.id,
        paymentMethod,
        paymentReference: paymentReference.trim() || undefined,
        paymentProofImage: paymentProofImage || undefined,
      });
      setActiveRide(await updated.json());
      showAlert(
        paymentMethod === 'cash' ? 'Cash payment recorded' : 'Payment submitted',
        paymentMethod === 'cash'
          ? 'Please pay the driver directly before ending the ride.'
          : 'Your payment is pending verification. Keep the transaction reference for your records.',
      );
    } catch (e: any) {
      const message = e.message || '';
      showAlert(
        'Payment error',
        message.includes('413') || message.toLowerCase().includes('entity too large')
          ? 'The payment screenshot is too large. Choose a smaller screenshot and try again.'
          : message || 'Could not submit payment',
      );
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const choosePaymentProof = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.3,
      base64: true,
    });
    if (!result.canceled && result.assets[0]?.base64) {
      const asset = result.assets[0];
      const encoded = `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;
      // Base64 expands the original image by roughly one third. Keep the
      // complete JSON request comfortably below Express's body limit.
      if ((asset.fileSize && asset.fileSize > 2_000_000) || encoded.length > 4_000_000) {
        showAlert('Screenshot too large', 'Please choose a screenshot smaller than 2 MB and try again.');
        return;
      }
      setPaymentProofImage(encoded);
    }
  };

  const doCancelRide = async () => {
    if (!activeRide?.id) return;
    try {
      const response = await apiRequest('PUT', `/api/rides/${activeRide.id}/status`, { status: 'cancelled', riderId: user?.id });
      const updated: Ride = await response.json();
      if (updated.cancellationPaymentRequired) {
        setActiveRide(updated);
        setPhase('matched');
        showAlert('Payment required', 'This ride had already been accepted by a driver. Please complete the cancellation payment below.');
      } else {
        setActiveRide(null);
        setPhase('idle');
        await fetchScheduledRides();
        setDropoffCoord(null);
        setDropoffAddress('');
        setFareEstimate(null);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch (e: any) {
      showAlert('Unable to cancel ride', e.message || 'Please try again.');
    }
  };

  const cancelScheduledRide = async (ride: Ride) => {
    try {
      const response = await apiRequest('PUT', `/api/rides/${ride.id}/status`, { status: 'cancelled', riderId: user?.id });
      const updated: Ride = await response.json();
      if (updated.cancellationPaymentRequired) {
        setActiveRide(updated);
        setPhase('matched');
        if (updated.driverId) fetchDriverInfo(updated.driverId);
        showAlert('Payment required', 'This scheduled ride had already been accepted by a driver. Please complete the cancellation payment below.');
      } else {
        await fetchScheduledRides();
        showAlert('Ride cancelled', 'Your scheduled ride was cancelled.');
      }
    } catch (e: any) {
      showAlert('Unable to cancel ride', e.message || 'Please try again.');
    }
  };

  const handleCancelRide = () => {
    if (!activeRide?.id) return;
    const currentPhase = phaseRef.current;
    if (currentPhase === 'matched' || currentPhase === 'riding') {
      showAlert(
        'Cancel Ride?',
        'You will still be charged the full fare if you cancel now. Due to our low platform fees and driver compensation model, we do not issue refunds for rides cancelled after a driver has been assigned.',
        [
          { label: 'Keep Ride', onPress: () => {} },
          { label: 'Cancel Anyway', destructive: true, onPress: doCancelRide },
        ]
      );
    } else {
      doCancelRide();
    }
  };

  const submitReview = async () => {
    if (!activeRide || reviewRating === 0) return;
    setReviewSubmitting(true);
    try {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/rides/${activeRide.id}/review`, baseUrl);
      const response = await authenticatedFetch(url.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: reviewRating, comment: reviewComment.trim() || undefined }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: 'Failed to submit review' }));
        throw new Error(body.message || 'Failed to submit review');
      }

      const reviewedRide = await response.json() as Ride;
      setActiveRide(reviewedRide);
      setReviewSubmitted(true);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Close the completed screen after a brief moment so the rating window
      // does not reappear due to polling or re-mounts.
      setTimeout(() => {
        setPhase('idle');
        setActiveRide(null);
        setDriverInfo(null);
      }, 2000);
    } catch {
      showAlert('Error', 'Failed to submit review. Please try again.');
    } finally {
      setReviewSubmitting(false);
    }
  };

  const handleNewRide = () => {
    setPhase('idle');
    setActiveRide(null);
    setDropoffCoord(null);
    setDropoffAddress('');
    setFareEstimate(null);
    setDriverInfo(null);
    setAddressInput('');
    setReviewRating(0);
    setReviewComment('');
    setReviewSubmitted(false);
  };

  const openMenu = () => {
    const menuActions: { label: string; icon: string; iconColor?: string; onPress: () => void; destructive?: boolean }[] = [];
    if (user?.role === 'driver') {
      menuActions.push({ label: 'Switch to Driver', icon: 'car', onPress: () => router.replace('/driver') });
    }
    if (user?.role === 'admin') {
      menuActions.push({ label: 'Admin Panel', icon: 'settings', iconColor: Colors.accent, onPress: () => router.replace('/admin') });
      menuActions.push({ label: 'Switch to Driver', icon: 'car', onPress: () => router.replace('/driver') });
    }
    menuActions.push({ label: 'Log Out', icon: 'log-out-outline', destructive: true, onPress: () => { logout(); router.replace('/'); } });
    showActionSheet('Menu', menuActions);
  };

  if (permissionStatus === null) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: Colors.backgroundDark }]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Getting your location...</Text>
      </View>
    );
  }

  if (permissionStatus !== 'granted' && Platform.OS !== 'web') {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: Colors.backgroundDark }]}>
        <Ionicons name="location-outline" size={48} color={Colors.textLight} />
        <Text style={styles.loadingText}>Location access is required</Text>
        <Pressable style={styles.permBtn} onPress={requestLocation}>
          <Text style={styles.permBtnText}>Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {location && (
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFillObject}
          provider={PROVIDER_DEFAULT}
          mapType={Platform.OS === 'android' ? 'none' : 'standard'}
          initialRegion={{
            latitude: location.lat,
            longitude: location.lng,
            latitudeDelta: LATITUDE_DELTA,
            longitudeDelta: LONGITUDE_DELTA,
          }}
          showsUserLocation
          showsMyLocationButton={false}
          onPress={handleMapPress}
        >
          <CartoTileLayer />

          {nearbyDrivers.filter((driver) => driver.id !== activeRide?.driverId).map((driver) => (
            <Marker
              key={driver.id}
              coordinate={{
                latitude: driver.currentLocation.lat,
                longitude: driver.currentLocation.lng,
              }}
              title={driver.fullName}
              description={`${driver.distance} KM away`}
            >
              <View style={styles.driverMarker}>
                <Ionicons name="car" size={16} color={Colors.textWhite} />
              </View>
            </Marker>
          ))}

          {routeCoordinates.length > 1 && (
            <Polyline
              coordinates={routeCoordinates}
              strokeColor={Colors.primary}
              strokeWidth={5}
            />
          )}

          {activeRide && activeDriverPosition && (
            <>
              {activeRide.status !== 'in_progress' && (
                <Marker
                  coordinate={{
                    latitude: activeRide.pickup.lat,
                    longitude: activeRide.pickup.lng,
                  }}
                  title="Pickup"
                >
                  <View style={styles.pickupMarker}>
                    <Ionicons name="person" size={15} color={Colors.textWhite} />
                  </View>
                </Marker>
              )}
              <Marker
                coordinate={{
                  latitude: activeRide.dropoff.lat,
                  longitude: activeRide.dropoff.lng,
                }}
                title="Destination"
              >
                <View style={styles.dropoffMarker}>
                  <Ionicons name="flag" size={16} color={Colors.textWhite} />
                </View>
              </Marker>
              <Marker
                coordinate={{
                  latitude: activeDriverPosition.lat,
                  longitude: activeDriverPosition.lng,
                }}
                title={driverInfo?.fullName || 'Your driver'}
                description={
                  activeRide.status === 'arrived'
                    ? 'Driver has arrived'
                    : driverEtaMinutes
                      ? `${driverEtaMinutes} min away`
                      : 'Updating driver location'
                }
              >
                <View style={styles.activeDriverMarker}>
                  <Ionicons name="car" size={17} color={Colors.textWhite} />
                </View>
              </Marker>
            </>
          )}

          {dropoffCoord && (
            <Marker
              coordinate={{
                latitude: dropoffCoord.lat,
                longitude: dropoffCoord.lng,
              }}
              title="Drop-off"
            >
              <View style={styles.dropoffMarker}>
                <Ionicons name="flag" size={16} color={Colors.textWhite} />
              </View>
            </Marker>
          )}
        </MapView>
      )}

      {Platform.OS === 'android' && location && (
        <View
          style={{
            position: 'absolute',
            top: topInset + 60,
            alignSelf: 'center',
            zIndex: 9,
            backgroundColor: 'rgba(255,255,255,0.88)',
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: 8,
          }}
        >
          <Text style={{ fontSize: 10, color: '#333' }}>
            © OpenStreetMap contributors © CARTO
          </Text>
        </View>
      )}

      <View style={[styles.topBar, { top: topInset + 8 }]}>
        <Pressable style={styles.menuBtn} onPress={openMenu}>
          <Ionicons name="menu" size={24} color={Colors.text} />
        </Pressable>

        <View style={styles.statusChip}>
          <View style={[styles.statusDot, { backgroundColor: Colors.driverOnline }]} />
          <Text style={styles.statusText}>
            {nearbyDrivers.length} driver{nearbyDrivers.length !== 1 ? 's' : ''} nearby
          </Text>
        </View>
      </View>

      {phase === 'idle' && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />
          <Text style={styles.cardTitle}>Where to?</Text>
          <Pressable
            style={styles.destinationInput}
            onPress={() => {
              setPhase('selecting_dropoff');
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <Ionicons name="search" size={20} color={Colors.textLight} />
            <Text style={styles.destinationPlaceholder}>Search or tap map to set destination</Text>
          </Pressable>
          <View style={styles.pickupRow}>
            <View style={styles.pickupDot} />
            <Text style={styles.pickupText} numberOfLines={1}>{pickupAddress}</Text>
          </View>
          {scheduledRides.length > 0 && <View style={styles.scheduledSection}>
            <View style={styles.scheduledHeader}><Ionicons name="calendar" size={17} color={Colors.primary} /><Text style={styles.scheduledTitle}>Your scheduled rides</Text></View>
            {scheduledRides.slice(0, 3).map(ride => <View key={ride.id} style={styles.scheduledCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.scheduledTime}>{new Date(ride.scheduledAt!).toLocaleString()}</Text>
                <Text style={styles.scheduledRoute} numberOfLines={1}>{ride.pickup.address} → {ride.dropoff.address}</Text>
                <Text style={styles.scheduledMeta}>{ride.driverId ? 'Driver accepted' : 'Waiting for driver acceptance'}</Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 5 }}>
                <Text style={styles.scheduledFare}>M{ride.fare?.totalFare.toFixed(2) ?? '0.00'}</Text>
                <Pressable style={styles.scheduledCancelButton} onPress={() => cancelScheduledRide(ride)}>
                  <Text style={styles.scheduledCancelText}>Cancel</Text>
                </Pressable>
              </View>
            </View>)}
          </View>}
        </Animated.View>
      )}

      {phase === 'selecting_dropoff' && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16, bottom: keyboardHeight }]}>
          <View style={styles.cardHandle} />
          <Text style={styles.cardTitle}>Set your destination</Text>

          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              placeholder="Type an address..."
              placeholderTextColor={Colors.textLight}
              value={addressInput}
              onChangeText={handleAddressInputChange}
              onSubmitEditing={searchAddress}
              returnKeyType="search"
              autoFocus={Platform.OS === 'web'}
            />
            <Pressable
              style={[styles.searchBtn, addressSearching && styles.btnDisabled]}
              onPress={searchAddress}
              disabled={addressSearching}
            >
              {addressSearching ? (
                <ActivityIndicator size="small" color={Colors.secondary} />
              ) : (
                <Ionicons name="search" size={20} color={Colors.secondary} />
              )}
            </Pressable>
          </View>

          {showSuggestions && addressSuggestions.length > 0 && (
            <View style={styles.suggestionsContainer}>
              {addressSuggestions.map((item, idx) => {
                const parts = item.display_name.split(',');
                const primary = parts.slice(0, 2).join(',').trim();
                const secondary = parts.slice(2, 5).join(',').trim();
                return (
                  <Pressable
                    key={`${item.lat}-${item.lon}-${idx}`}
                    style={({ pressed }) => [styles.suggestionItem, pressed && { backgroundColor: Colors.background }, idx < addressSuggestions.length - 1 && styles.suggestionBorder]}
                    onPress={() => selectSuggestion(item)}
                  >
                    <Ionicons name="location-outline" size={18} color={Colors.primary} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.suggestionPrimary} numberOfLines={1}>{primary}</Text>
                      {secondary ? <Text style={styles.suggestionSecondary} numberOfLines={1}>{secondary}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          <Text style={styles.orDividerText}>or tap on the map</Text>

          {dropoffCoord ? (
            <>
              <View style={styles.routeInfo}>
                <View style={styles.routePoint}>
                  <View style={styles.pickupDot} />
                  <Text style={styles.routeText} numberOfLines={1}>{pickupAddress}</Text>
                </View>
                <View style={styles.routeDivider} />
                <View style={styles.routePoint}>
                  <View style={styles.dropoffDot} />
                  <Text style={styles.routeText} numberOfLines={1}>{dropoffAddress}</Text>
                </View>
              </View>

              <View style={styles.btnRow}>
                <Pressable
                  style={({ pressed }) => [styles.cancelBtn, pressed && styles.btnPressed]}
                  onPress={() => { setPhase('idle'); setDropoffCoord(null); setDropoffAddress(''); setAddressInput(''); setShowSuggestions(false); setAddressSuggestions([]); }}
                >
                  <Ionicons name="close" size={20} color={Colors.textLight} />
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.confirmBtn, pressed && styles.btnPressed, loading && styles.btnDisabled]}
                  onPress={handleConfirmDropoff}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color={Colors.secondary} />
                  ) : (
                    <>
                      <Ionicons name="checkmark" size={20} color={Colors.secondary} />
                      <Text style={styles.confirmBtnText}>Get Fare</Text>
                    </>
                  )}
                </Pressable>
              </View>

              <View style={styles.rideTypeRow}>
                <Pressable
                  style={[styles.rideTypeBtn, rideType === 'private' && styles.rideTypeBtnActive]}
                  onPress={() => setRideType('private')}
                >
                  <Ionicons name="car" size={18} color={rideType === 'private' ? Colors.secondary : Colors.textLight} />
                  <Text style={[styles.rideTypeLabel, rideType === 'private' && styles.rideTypeLabelActive]}>Private</Text>
                </Pressable>
                <Pressable
                  style={[styles.rideTypeBtn, rideType === 'shared' && styles.rideTypeBtnActive]}
                  onPress={() => { setRideType('shared'); setServiceType('ride'); }}
                >
                  <Ionicons name="people" size={18} color={rideType === 'shared' ? Colors.secondary : Colors.textLight} />
                  <Text style={[styles.rideTypeLabel, rideType === 'shared' && styles.rideTypeLabelActive]}>Shared</Text>
                </Pressable>
              </View>

              <View style={styles.rideTypeRow}>
                <Pressable style={[styles.rideTypeBtn, serviceType === 'ride' && styles.rideTypeBtnActive]} onPress={() => setServiceType('ride')}>
                  <Ionicons name="car-outline" size={18} color={serviceType === 'ride' ? Colors.secondary : Colors.textLight} />
                  <Text style={[styles.rideTypeLabel, serviceType === 'ride' && styles.rideTypeLabelActive]}>Ride</Text>
                </Pressable>
                <Pressable style={[styles.rideTypeBtn, serviceType === 'parcel' && styles.rideTypeBtnActive]} onPress={() => { setServiceType('parcel'); setRideType('shared'); setAdditionalPassengers(0); }}>
                  <Ionicons name="cube-outline" size={18} color={serviceType === 'parcel' ? Colors.secondary : Colors.textLight} />
                  <Text style={[styles.rideTypeLabel, serviceType === 'parcel' && styles.rideTypeLabelActive]}>Parcel delivery</Text>
                </Pressable>
              </View>

              {serviceType === 'parcel' && <View style={styles.parcelBox}>
                <Text style={styles.parcelHelp}>Parcel price uses shared-ride pricing per seat, adjusted for weight and volume.</Text>
                <View style={styles.parcelInputs}>
                  {[[parcelWeight, setParcelWeight, 'Weight kg'], [parcelLength, setParcelLength, 'Length cm'], [parcelWidth, setParcelWidth, 'Width cm'], [parcelHeight, setParcelHeight, 'Height cm']].map(([value, setter, label]) => (
                    <TextInput key={label as string} style={styles.parcelInput} placeholder={label as string} placeholderTextColor={Colors.textLight} keyboardType="decimal-pad" value={value as string} onChangeText={setter as (value: string) => void} />
                  ))}
                </View>
                <TextInput style={styles.parcelInputWide} placeholder="What is in the parcel? (optional)" placeholderTextColor={Colors.textLight} value={parcelDescription} onChangeText={setParcelDescription} maxLength={200} />
                <Pressable style={styles.parcelPhotoButton} onPress={async () => {
                  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.35, base64: true });
                  if (!result.canceled && result.assets[0]?.base64) setParcelPhoto(`data:${result.assets[0].mimeType || 'image/jpeg'};base64,${result.assets[0].base64}`);
                }}>
                  {parcelPhoto ? <Image source={{ uri: parcelPhoto }} style={styles.parcelThumb} /> : <Ionicons name="camera-outline" size={20} color={Colors.primary} />}
                  <Text style={styles.parcelPhotoText}>{parcelPhoto ? 'Parcel photo attached' : 'Add parcel photo'}</Text>
                </Pressable>
              </View>}

              {serviceType === 'ride' && additionalPassengers > 0 && (
                <View style={styles.passengerRow}>
                  <Text style={styles.passengerLabel}>Total passengers:</Text>
                  <Text style={styles.passengerValue}>{1 + additionalPassengers}</Text>
                </View>
              )}

              {serviceType === 'ride' && (
                <View style={styles.passengerControls}>
                  <Pressable
                    style={styles.passengerBtn}
                    onPress={() => setAdditionalPassengers(Math.max(0, additionalPassengers - 1))}
                    disabled={additionalPassengers === 0}
                  >
                    <Ionicons name="remove" size={20} color={additionalPassengers === 0 ? Colors.textLight : Colors.secondary} />
                  </Pressable>
                  <Text style={styles.passengerCountText}>{1 + additionalPassengers}</Text>
                  <Pressable
                    style={styles.passengerBtn}
                    onPress={() => setAdditionalPassengers(Math.min(7, additionalPassengers + 1))}
                    disabled={additionalPassengers === 7}
                  >
                    <Ionicons name="add" size={20} color={additionalPassengers === 7 ? Colors.textLight : Colors.secondary} />
                  </Pressable>
                </View>
              )}
            </>
          ) : (
            <View style={styles.tapHint}>
              <Ionicons name="location" size={28} color={Colors.textLight} />
              <Text style={styles.tapHintText}>Search above or tap the map</Text>
            </View>
          )}
        </Animated.View>
      )}

      {phase === 'confirming' && fareEstimate && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />
          <Text style={styles.cardTitle}>Confirm Your Ride</Text>

          <View style={styles.fareCard}>
            <View style={styles.fareMain}>
              <Text style={styles.fareLabel}>Estimated Fare</Text>
              <Text style={styles.farePrice}>M{fareEstimate.totalFare.toFixed(2)}</Text>
              <Text style={styles.cashFareNote}>
                Cash payment: M{(fareEstimate.cashTotalFare ?? roundCashFare(fareEstimate.totalFare)).toFixed(0)}
              </Text>
            </View>
            <View style={styles.fareDetails}>
              <FareRow label="Base fare" value={`M${fareEstimate.baseFare.toFixed(2)}`} />
              <FareRow label={`Distance (${fareEstimate.distance} KM)`} value={`M${fareEstimate.distanceFare.toFixed(2)}`} />
              <FareRow label={`Time (~${fareEstimate.duration} min)`} value={`M${fareEstimate.timeFare.toFixed(2)}`} />
              {serviceType === 'ride' && rideType === 'shared' && additionalPassengers > 0 && <FareRow label="Additional passenger fee (10% each)" value={`M${(fareEstimate.passengerFare || 0).toFixed(2)}`} />}
              {serviceType === 'ride' && rideType === 'private' && additionalPassengers > 0 && <FareRow label="Passengers (vehicle fare)" value={`${1 + additionalPassengers}`} />}
              {serviceType === 'parcel' && <FareRow label={`Parcel size/weight (${fareEstimate.parcelMultiplier || 1} seat units)`} value={`M${(fareEstimate.parcelFare || 0).toFixed(2)}`} />}
            </View>
          </View>

          <Pressable style={styles.scheduleToggle} onPress={() => setScheduleEnabled(value => !value)}>
            <Ionicons name={scheduleEnabled ? 'calendar' : 'calendar-outline'} size={19} color={Colors.primary} />
            <Text style={styles.scheduleToggleText}>{scheduleEnabled ? 'Scheduled pickup selected' : 'Schedule this booking'}</Text>
            <Ionicons name={scheduleEnabled ? 'checkmark-circle' : 'chevron-forward'} size={19} color={scheduleEnabled ? Colors.success : Colors.textLight} />
          </Pressable>
          {scheduleEnabled && <View style={styles.schedulePickerBox}>
            <View style={styles.scheduleButtons}>
              <Pressable style={styles.scheduleButton} onPress={() => setShowDatePicker(value => !value)}>
                <Ionicons name="calendar-outline" size={18} color={Colors.primary} />
                <Text style={styles.scheduleButtonText}>{scheduledDate.toLocaleDateString()}</Text>
              </Pressable>
              <Pressable style={styles.scheduleButton} onPress={() => setShowTimePicker(value => !value)}>
                <Ionicons name="time-outline" size={18} color={Colors.primary} />
                <Text style={styles.scheduleButtonText}>{scheduledDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
              </Pressable>
            </View>
            {Platform.OS === 'web' ? <WebScheduleInputs value={scheduledDate} onChange={setScheduledDate} /> : <>
            {showDatePicker && <DateTimePicker
              value={scheduledDate}
              mode="date"
              minimumDate={new Date()}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event: DateTimePickerEvent, value?: Date) => {
                setShowDatePicker(Platform.OS === 'ios');
                if (event.type === 'set' && value) {
                  const next = new Date(scheduledDate);
                  next.setFullYear(value.getFullYear(), value.getMonth(), value.getDate());
                  setScheduledDate(next);
                }
              }}
            />}
            {showTimePicker && <DateTimePicker
              value={scheduledDate}
              mode="time"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              onChange={(event: DateTimePickerEvent, value?: Date) => {
                setShowTimePicker(Platform.OS === 'ios');
                if (event.type === 'set' && value) {
                  const next = new Date(scheduledDate);
                  next.setHours(value.getHours(), value.getMinutes(), 0, 0);
                  setScheduledDate(next);
                }
              }}
            />}
            </>}
          </View>}

          <View style={styles.btnRow}>
            <Pressable
              style={({ pressed }) => [styles.cancelBtn, pressed && styles.btnPressed]}
              onPress={() => setPhase('selecting_dropoff')}
            >
              <Ionicons name="arrow-back" size={20} color={Colors.textLight} />
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.confirmBtn, pressed && styles.btnPressed, loading && styles.btnDisabled]}
              onPress={handleRequestRide}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color={Colors.secondary} />
              ) : (
                <>
                  <Ionicons name="car" size={20} color={Colors.secondary} />
                  <Text style={styles.confirmBtnText}>Request Ride</Text>
                </>
              )}
            </Pressable>
          </View>
        </Animated.View>
      )}

      {phase === 'waiting' && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />
          <View style={styles.waitingContent}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.waitingTitle}>{activeRide?.scheduledAt ? 'Ride scheduled' : 'Finding drivers for your ride'}</Text>
            <Text style={styles.waitingSubtitle}>
              {activeRide?.scheduledAt ? `Pickup time: ${new Date(activeRide.scheduledAt).toLocaleString()}. Drivers can accept this booking in advance.` : 'Drivers nearby are assessing your route. You&apos;ll be notified when a driver accepts.'}
            </Text>
            {activeRide && <BookingDetails ride={activeRide} />}
          </View>

          {!activeRide?.cancellationPaymentRequired && <Pressable
            style={({ pressed }) => [styles.cancelRideBtn, pressed && styles.btnPressed]}
            onPress={handleCancelRide}
          >
            <Text style={styles.cancelRideBtnText}>Cancel Ride</Text>
          </Pressable>}
        </Animated.View>
      )}

      {(phase === 'matched' || phase === 'riding') && activeRide && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />

          <View style={styles.rideStatusBar}>
            <View style={[styles.rideStatusDot, { backgroundColor: phase === 'riding' ? Colors.primary : Colors.warning }]} />
            <Text style={styles.rideStatusText}>
              {activeRide.status === 'cancelled' && 'Cancellation payment required'}
              {activeRide.status === 'accepted' && 'Driver on the way'}
              {activeRide.status === 'arriving' && 'Driver is arriving'}
              {activeRide.status === 'arrived' && 'Driver has arrived'}
              {activeRide.status === 'in_progress' && 'Ride in progress'}
            </Text>
          </View>

          <View style={styles.etaRow}>
            <Ionicons name="time-outline" size={19} color={Colors.primary} />
            <Text style={styles.etaLabel}>
              {activeRide.status === 'in_progress' ? 'Destination ETA' : 'Driver ETA'}
            </Text>
            <Text style={styles.etaValue}>
              {activeRide.status === 'arrived'
                ? 'Arrived'
                : driverEtaMinutes
                  ? `${driverEtaMinutes} min`
                  : 'Updating...'}
            </Text>
          </View>

          <BookingDetails ride={activeRide} />

          {driverInfo && (
            <View style={styles.driverCard}>
              <View style={styles.driverAvatar}>
                <Ionicons name="person" size={24} color={Colors.primary} />
              </View>
              <View style={styles.driverDetails}>
                <Text style={styles.driverName}>{driverInfo.fullName}</Text>
                <View style={styles.driverMeta}>
                  <Ionicons name="star" size={14} color={Colors.warning} />
                  <Text style={styles.driverRating}>{(driverInfo.rating || 5.0).toFixed(1)}</Text>
                  {driverInfo.vehicleInfo && (
                    <Text style={styles.driverVehicle}>
                      {driverInfo.vehicleInfo.color} {driverInfo.vehicleInfo.make} {driverInfo.vehicleInfo.model}
                    </Text>
                  )}
                </View>
                {driverInfo.vehicleInfo && (
                  <Text style={styles.driverPlate}>{driverInfo.vehicleInfo.plate}</Text>
                )}
              </View>
            </View>
          )}

          {(activeRide.status === 'in_progress' || activeRide.cancellationPaymentRequired) && !activeRide.payment && (
            <View style={styles.ridePaymentCard}>
              <View style={styles.ridePaymentHeader}>
                <Text style={styles.ridePaymentTitle}>{activeRide.cancellationPaymentRequired ? 'Pay cancellation charge' : 'Pay for this ride'}</Text>
                <Text style={styles.ridePaymentAmount}>
                  M{paymentMethod === 'cash'
                    ? (activeRide.fare?.cashTotalFare ?? roundCashFare(activeRide.fare?.totalFare ?? 0)).toFixed(0)
                    : (activeRide.fare?.totalFare ?? 0).toFixed(2)}
                </Text>
              </View>
              <View style={styles.paymentMethodRow}>
                {([
                  ['cash', 'cash-outline', 'Cash'],
                  ['mpesa', 'phone-portrait-outline', 'M-Pesa'],
                  ['ecocash', 'wallet-outline', 'EcoCash'],
                ] as const).map(([method, icon, label]) => (
                  <Pressable
                    key={method}
                    style={[styles.paymentMethodBtn, paymentMethod === method && styles.paymentMethodBtnActive]}
                    onPress={() => setPaymentMethod(method)}
                  >
                    <Ionicons name={icon} size={17} color={paymentMethod === method ? Colors.secondary : Colors.textLight} />
                    <Text style={[styles.paymentMethodText, paymentMethod === method && styles.paymentMethodTextActive]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              {paymentMethod === 'cash' ? (
                <Text style={styles.paymentHint}>{activeRide.cancellationPaymentRequired ? 'Pay the cancellation charge in cash to the driver or choose a mobile-money method.' : 'Pay the driver directly before ending the ride.'}</Text>
              ) : (
                <>
                  <Text style={styles.paymentHint}>Pay the U-GO merchant account, then enter the transaction number. Never enter your wallet PIN here.</Text>
                  <TextInput
                    style={styles.paymentReferenceInput}
                    placeholder="Transaction number"
                    placeholderTextColor={Colors.textLight}
                    value={paymentReference}
                    onChangeText={setPaymentReference}
                    autoCapitalize="characters"
                    maxLength={80}
                  />
                  <Pressable style={styles.proofButton} onPress={choosePaymentProof}>
                    <Ionicons name={paymentProofImage ? 'checkmark-circle' : 'camera-outline'} size={18} color={Colors.primary} />
                    <Text style={styles.proofButtonText}>{paymentProofImage ? 'Screenshot attached' : 'Attach payment screenshot (optional)'}</Text>
                  </Pressable>
                </>
              )}
              <Pressable
                style={({ pressed }) => [styles.submitPaymentBtn, pressed && styles.btnPressed, paymentSubmitting && styles.btnDisabled]}
                onPress={submitRidePayment}
                disabled={paymentSubmitting}
              >
                {paymentSubmitting ? <ActivityIndicator size="small" color={Colors.secondary} /> : <Text style={styles.submitPaymentText}>{paymentMethod === 'cash' ? 'Record cash payment' : 'Submit payment'}</Text>}
              </Pressable>
            </View>
          )}

          {activeRide.payment && (
            <View style={styles.paymentStatusRow}>
              <Ionicons name={activeRide.payment.status === 'paid' ? 'checkmark-circle' : 'time-outline'} size={18} color={activeRide.payment.status === 'paid' ? Colors.success : Colors.warning} />
              <Text style={styles.paymentStatusText}>
                {activeRide.payment.status === 'paid' ? 'Payment confirmed' : activeRide.payment.status === 'pending_cash' ? 'Cash payment due to driver' : 'Payment submitted for verification'}
              </Text>
            </View>
          )}

          {activeRide.fare && (
            <View style={styles.rideFareRow}>
              <Text style={styles.rideFareLabel}>Fare</Text>
              <Text style={styles.rideFareValue}>
                M{activeRide.payment?.method === 'cash'
                  ? (activeRide.payment.amount ?? activeRide.fare.cashTotalFare ?? roundCashFare(activeRide.fare.totalFare)).toFixed(0)
                  : activeRide.fare.totalFare.toFixed(2)}
              </Text>
            </View>
          )}

          {!activeRide.cancellationPaymentRequired && <Pressable
            style={({ pressed }) => [styles.cancelRideBtn, pressed && styles.btnPressed]}
            onPress={handleCancelRide}
          >
            <Text style={styles.cancelRideBtnText}>Cancel Ride</Text>
          </Pressable>}
        </Animated.View>
      )}

      {phase === 'completed' && activeRide && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16, bottom: keyboardHeight }]}>
          <View style={styles.cardHandle} />
          <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: height * 0.55 }}>
            <View style={styles.completedContent}>
              <View style={styles.completedIcon}>
                <Ionicons name="checkmark-circle" size={48} color={Colors.success} />
              </View>
              <Text style={styles.completedTitle}>Ride Complete!</Text>
              {activeRide.fare && (
                <Text style={styles.completedFare}>
                  M{activeRide.payment?.method === 'cash'
                    ? (activeRide.payment.amount ?? activeRide.fare.cashTotalFare ?? roundCashFare(activeRide.fare.totalFare)).toFixed(0)
                    : activeRide.fare.totalFare.toFixed(2)}
                </Text>
              )}
            </View>

            {!reviewSubmitted ? (
              <View style={styles.reviewSection}>
                <Text style={styles.reviewTitle}>Rate your driver</Text>
                {driverInfo && (
                  <Text style={styles.reviewDriverName}>{driverInfo.fullName}</Text>
                )}
                <View style={styles.starsRow}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Pressable
                      key={star}
                      onPress={() => {
                        setReviewRating(star);
                        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                      hitSlop={8}
                    >
                      <Ionicons
                        name={star <= reviewRating ? 'star' : 'star-outline'}
                        size={40}
                        color={star <= reviewRating ? '#FFB800' : Colors.border}
                      />
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  style={styles.reviewInput}
                  placeholder="Leave a private comment for admin (optional)"
                  placeholderTextColor={Colors.textLight}
                  value={reviewComment}
                  onChangeText={setReviewComment}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                  maxLength={500}
                />
                <Text style={styles.reviewPrivacyNote}>
                  <Ionicons name="lock-closed" size={11} color={Colors.textLight} /> Your comment is private and only visible to platform admins
                </Text>
                <View style={styles.reviewBtnRow}>
                  <Pressable
                    style={({ pressed }) => [styles.reviewSkipBtn, pressed && styles.btnPressed]}
                    onPress={handleNewRide}
                  >
                    <Ionicons name="arrow-forward" size={20} color={Colors.textLight} />
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [
                      styles.confirmBtn,
                      reviewRating === 0 && styles.btnDisabled,
                      pressed && styles.btnPressed,
                    ]}
                    onPress={submitReview}
                    disabled={reviewRating === 0 || reviewSubmitting}
                  >
                    {reviewSubmitting ? (
                      <ActivityIndicator size="small" color={Colors.secondary} />
                    ) : (
                      <Text style={styles.confirmBtnText}>Submit Review</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.reviewSection}>
                <View style={styles.reviewThanks}>
                  <Ionicons name="heart" size={28} color={Colors.primary} />
                  <Text style={styles.reviewThanksText}>Thank you for your feedback!</Text>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.confirmBtn, { width: '100%' as any }, pressed && styles.btnPressed]}
                  onPress={handleNewRide}
                >
                  <Text style={styles.confirmBtnText}>Request Another Ride</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      )}

      <AppModal {...modalProps} />
    </View>
  );
}

function FareRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={styles.fareRow}>
      <Text style={[styles.fareRowLabel, highlight && styles.fareHighlight]}>{label}</Text>
      <Text style={[styles.fareRowValue, highlight && styles.fareHighlight]}>{value}</Text>
    </View>
  );
}

function BookingDetails({ ride }: { ride: Ride }) {
  return (
    <View style={styles.bookingDetails}>
      <Text style={styles.bookingType}>{ride.serviceType === 'parcel' ? 'Parcel delivery' : `${ride.rideType === 'shared' ? 'Shared' : 'Private'} ride`}</Text>
      {ride.scheduledAt && <Text style={styles.bookingDetailText}>Pickup: {new Date(ride.scheduledAt).toLocaleString()}</Text>}
      {ride.serviceType === 'parcel' && ride.parcel && <>
        <Text style={styles.bookingDetailText}>Weight: {ride.parcel.weightKg} kg · Size: {ride.parcel.lengthCm} × {ride.parcel.widthCm} × {ride.parcel.heightCm} cm</Text>
        {ride.parcel.photo && <Image source={{ uri: ride.parcel.photo }} style={styles.bookingParcelPhoto} />}
      </>}
      {ride.serviceType !== 'parcel' && <Text style={styles.bookingDetailText}>Passengers: {ride.passengerCount || 1}</Text>}
    </View>
  );
}

function WebScheduleInputs({ value, onChange }: { value: Date; onChange: (value: Date) => void }) {
  const dateValue = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const timeValue = `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  const updateDate = (nextValue: string) => {
    const [year, month, day] = nextValue.split('-').map(Number);
    if (!year || !month || !day) return;
    const next = new Date(value);
    next.setFullYear(year, month - 1, day);
    onChange(next);
  };
  const updateTime = (nextValue: string) => {
    const [hours, minutes] = nextValue.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return;
    const next = new Date(value);
    next.setHours(hours, minutes, 0, 0);
    onChange(next);
  };
  const inputStyle = { flex: 1, minWidth: 0, border: `1px solid ${Colors.border}`, borderRadius: 9, padding: 10, color: Colors.text, backgroundColor: Colors.surface, fontSize: 13 };
  return <View style={styles.scheduleButtons}>
    {React.createElement('input', { type: 'date', value: dateValue, min: new Date().toISOString().slice(0, 10), onChange: (event: any) => updateDate(event.target.value), style: inputStyle })}
    {React.createElement('input', { type: 'time', value: timeValue, onChange: (event: any) => updateTime(event.target.value), style: inputStyle })}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loadingContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16,
  },
  loadingText: {
    fontSize: 16, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  permBtn: {
    backgroundColor: Colors.primary, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 14, marginTop: 8,
  },
  permBtnText: {
    fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.secondary,
  },
  topBar: {
    position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', zIndex: 10,
  },
  menuBtn: {
    width: 44, height: 44, borderRadius: 14, backgroundColor: Colors.mapOverlay, justifyContent: 'center', alignItems: 'center',
    ...(Platform.OS !== 'web' ? { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4 } : {}),
  },
  statusChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.mapOverlay, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20,
    ...(Platform.OS !== 'web' ? { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4 } : {}),
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text },
  driverMarker: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.secondary, justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: Colors.primary,
  },
  activeDriverMarker: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
    borderWidth: 3, borderColor: Colors.surface,
  },
  pickupMarker: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.secondary, justifyContent: 'center', alignItems: 'center',
  },
  dropoffMarker: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.accent, justifyContent: 'center', alignItems: 'center',
  },
  bottomCard: {
    position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingTop: 12, zIndex: 5,
    ...(Platform.OS !== 'web' ? { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 16, elevation: 10 } : {}),
  },
  cardHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center', marginBottom: 16,
  },
  cardTitle: {
    fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text, marginBottom: 16,
  },
  destinationInput: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Colors.background, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14,
  },
  destinationPlaceholder: {
    fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  searchRow: {
    flexDirection: 'row', gap: 8, marginBottom: 8,
  },
  searchInput: {
    flex: 1, backgroundColor: Colors.background, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12,
    fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text,
  },
  searchBtn: {
    width: 48, height: 48, borderRadius: 14, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
  },
  orDividerText: {
    fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.textLight, textAlign: 'center', marginBottom: 12,
  },
  suggestionsContainer: {
    backgroundColor: Colors.surface, borderRadius: 14, marginBottom: 8, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden',
  },
  suggestionItem: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 12,
  },
  suggestionBorder: {
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  suggestionPrimary: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text,
  },
  suggestionSecondary: {
    fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.textLight, marginTop: 2,
  },
  pickupRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12,
  },
  pickupDot: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary,
  },
  pickupText: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text, flex: 1,
  },
  scheduledSection: { marginTop: 14, gap: 7 },
  scheduledHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  scheduledTitle: { color: Colors.text, fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  scheduledCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.background, borderRadius: 10, padding: 9 },
  scheduledTime: { color: Colors.primary, fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  scheduledRoute: { color: Colors.text, fontSize: 11, marginTop: 2 },
  scheduledMeta: { color: Colors.textLight, fontSize: 10, marginTop: 2 },
  scheduledFare: { color: Colors.text, fontFamily: 'Inter_700Bold', fontSize: 13 },
  scheduledCancelButton: { borderWidth: 1, borderColor: Colors.error, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  scheduledCancelText: { color: Colors.error, fontSize: 10, fontFamily: 'Inter_600SemiBold' },
  routeInfo: { gap: 4, marginBottom: 16 },
  routePoint: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  routeDivider: {
    width: 2, height: 16, backgroundColor: Colors.border, marginLeft: 4,
  },
  dropoffDot: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.accent,
  },
  routeText: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text, flex: 1,
  },
  tapHint: {
    alignItems: 'center', gap: 8, paddingVertical: 16,
  },
  tapHintText: {
    fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  btnRow: {
    flexDirection: 'row', gap: 12, marginTop: 4,
  },
  cancelBtn: {
    width: 52, height: 52, borderRadius: 16, backgroundColor: Colors.background, justifyContent: 'center', alignItems: 'center',
  },
  confirmBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, paddingVertical: 16, borderRadius: 14,
  },
  confirmBtnText: {
    fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.secondary,
  },
  btnPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  btnDisabled: { opacity: 0.6 },
  rideTypeRow: {
    flexDirection: 'row', gap: 8, marginTop: 12,
  },
  rideTypeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: Colors.background, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
  },
  rideTypeBtnActive: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
  },
  rideTypeLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  rideTypeLabelActive: {
    color: Colors.secondary,
  },
  parcelBox: { backgroundColor: Colors.background, borderRadius: 14, padding: 12, marginTop: 10, gap: 9 },
  parcelHelp: { color: Colors.textLight, fontSize: 12, lineHeight: 17 },
  parcelInputs: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  parcelInput: { flexGrow: 1, flexBasis: '46%', backgroundColor: Colors.surface, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 9, color: Colors.text, fontSize: 12 },
  parcelInputWide: { backgroundColor: Colors.surface, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 9, color: Colors.text, fontSize: 12 },
  parcelPhotoButton: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: Colors.primary, borderRadius: 9, padding: 9 },
  parcelPhotoText: { color: Colors.primary, fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  parcelThumb: { width: 34, height: 34, borderRadius: 6 },
  passengerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8,
  },
  passengerLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  passengerValue: {
    fontSize: 14, fontFamily: 'Inter_700Bold', color: Colors.text,
  },
  passengerControls: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8,
  },
  passengerBtn: {
    width: 40, height: 40, borderRadius: 10, backgroundColor: Colors.background, justifyContent: 'center', alignItems: 'center',
  },
  passengerCountText: {
    fontSize: 16, fontFamily: 'Inter_700Bold', color: Colors.text,
  },
  fareCard: {
    backgroundColor: Colors.background, borderRadius: 16, padding: 16, marginBottom: 16,
  },
  scheduleToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.background, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 12, marginBottom: 10 },
  scheduleToggleText: { flex: 1, color: Colors.text, fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  schedulePickerBox: { backgroundColor: Colors.background, borderRadius: 11, padding: 10, marginBottom: 12 },
  scheduleButtons: { flexDirection: 'row', gap: 8 },
  scheduleButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: Colors.surface, borderRadius: 9, paddingVertical: 10 },
  scheduleButtonText: { color: Colors.text, fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  fareMain: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12,
  },
  fareLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  farePrice: {
    fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text,
  },
  cashFareNote: {
    color: Colors.primary, fontSize: 12, fontFamily: 'Inter_600SemiBold', marginTop: 3,
  },
  fareDetails: { gap: 6 },
  fareRow: {
    flexDirection: 'row', justifyContent: 'space-between',
  },
  fareRowLabel: {
    fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  fareRowValue: {
    fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text,
  },
  fareHighlight: { color: Colors.primary, fontFamily: 'Inter_600SemiBold' },
  fareDivider: {
    height: 1, backgroundColor: Colors.border, marginVertical: 4,
  },
  paymentTitle: {
    fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.text, marginTop: 4, marginBottom: 8,
  },
  paymentMethodRow: {
    flexDirection: 'row', gap: 6, marginBottom: 8,
  },
  paymentMethodBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.background,
  },
  paymentMethodBtnActive: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
  },
  paymentMethodText: {
    fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  paymentMethodTextActive: {
    color: Colors.secondary,
  },
  mobilePaymentBox: {
    backgroundColor: 'rgba(54, 214, 197, 0.08)', borderRadius: 12, padding: 10, marginBottom: 8,
  },
  paymentHint: {
    fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular', color: Colors.textLight, marginBottom: 8,
  },
  paymentReferenceInput: {
    backgroundColor: Colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text, marginBottom: 8,
  },
  proofButton: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 5,
  },
  proofButtonText: {
    fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.primary,
  },
  waitingContent: {
    alignItems: 'center', gap: 12, paddingVertical: 20,
  },
  waitingTitle: {
    fontSize: 18, fontFamily: 'Inter_600SemiBold', color: Colors.text,
  },
  waitingSubtitle: {
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  bookingDetails: { width: '100%', backgroundColor: Colors.background, borderRadius: 11, padding: 10, marginTop: 12 },
  bookingType: { color: Colors.text, fontFamily: 'Inter_600SemiBold', fontSize: 13, marginBottom: 4 },
  bookingDetailText: { color: Colors.textLight, fontSize: 12, lineHeight: 18 },
  bookingParcelPhoto: { width: 72, height: 54, borderRadius: 7, marginTop: 7 },
  cancelRideBtn: {
    backgroundColor: 'rgba(255, 59, 48, 0.1)', paddingVertical: 14, borderRadius: 14, alignItems: 'center', marginTop: 8,
  },
  cancelRideBtnText: {
    fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.error,
  },
  rideStatusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16,
  },
  rideStatusDot: {
    width: 10, height: 10, borderRadius: 5,
  },
  rideStatusText: {
    fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.text,
  },
  etaRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(54, 214, 197, 0.1)', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
  },
  etaLabel: {
    flex: 1, fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text,
  },
  etaValue: {
    fontSize: 15, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  ridePaymentCard: {
    backgroundColor: 'rgba(54, 214, 197, 0.08)', borderRadius: 14, padding: 12, marginBottom: 12,
  },
  ridePaymentHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8,
  },
  ridePaymentTitle: {
    fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.text,
  },
  ridePaymentAmount: {
    fontSize: 17, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  submitPaymentBtn: {
    alignItems: 'center', justifyContent: 'center', minHeight: 40, paddingVertical: 9, borderRadius: 10, backgroundColor: Colors.primary, marginTop: 4,
  },
  submitPaymentText: {
    fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.secondary,
  },
  paymentStatusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, marginBottom: 4,
  },
  paymentStatusText: {
    fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  driverCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: Colors.background, borderRadius: 16, padding: 14, marginBottom: 12,
  },
  driverAvatar: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(54, 214, 197, 0.12)', justifyContent: 'center', alignItems: 'center',
  },
  driverDetails: { flex: 1 },
  driverName: {
    fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.text,
  },
  driverMeta: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2,
  },
  driverRating: {
    fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.text,
  },
  driverVehicle: {
    fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  driverPlate: {
    fontSize: 14, fontFamily: 'Inter_700Bold', color: Colors.primary, marginTop: 2, letterSpacing: 1,
  },
  rideFareRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8,
  },
  rideFareLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  rideFareValue: {
    fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text,
  },
  completedContent: {
    alignItems: 'center', gap: 8, paddingVertical: 12, marginBottom: 4,
  },
  completedIcon: { marginBottom: 4 },
  completedTitle: {
    fontSize: 22, fontFamily: 'Inter_700Bold', color: Colors.text,
  },
  completedFare: {
    fontSize: 32, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  completedSubtitle: {
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  reviewSection: {
    paddingTop: 8, paddingBottom: 4,
  },
  reviewTitle: {
    fontSize: 17, fontFamily: 'Inter_600SemiBold', color: Colors.text, textAlign: 'center', marginBottom: 4,
  },
  reviewDriverName: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight, textAlign: 'center', marginBottom: 12,
  },
  starsRow: {
    flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 16,
  },
  reviewInput: {
    backgroundColor: Colors.background, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12,
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.text, minHeight: 80, marginBottom: 6,
  },
  reviewPrivacyNote: {
    fontSize: 11, fontFamily: 'Inter_400Regular', color: Colors.textLight, textAlign: 'center', marginBottom: 16,
  },
  reviewBtnRow: {
    flexDirection: 'row', gap: 12,
  },
  reviewSkipBtn: {
    width: 52, height: 52, borderRadius: 16, backgroundColor: Colors.background, justifyContent: 'center', alignItems: 'center',
  },
  reviewThanks: {
    alignItems: 'center', gap: 10, paddingVertical: 20, marginBottom: 16,
  },
  reviewThanksText: {
    fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.text,
  },
});
