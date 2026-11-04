import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform, TextInput,
  ActivityIndicator, Dimensions, ScrollView, Linking, Keyboard,
} from 'react-native';
import { router } from 'expo-router';
import MapView, {
  Marker,
  PROVIDER_DEFAULT,
  CartoTileLayer,
} from '@/components/MapView';
import AppModal, { useAppModal } from '@/components/AppModal';
import * as Location from 'expo-location';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest, getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';
import Animated, { FadeInDown, FadeInUp, SlideInDown, FadeIn } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { Ride, User } from '@shared/schema';
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
  const [rideType, setRideType] = useState<'private' | 'shared'>('private');
  const [additionalPassengers, setAdditionalPassengers] = useState(0);
  const [activeRide, setActiveRide] = useState<Ride | null>(null);
  const [driverInfo, setDriverInfo] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [addressInput, setAddressInput] = useState('');
  const [addressSearching, setAddressSearching] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<Array<{ display_name: string; lat: string; lon: string }>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  const phaseRef = useRef<RiderPhase>(phase);
  const activeRideRef = useRef<Ride | null>(activeRide);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const eventsInitializedRef = useRef(false);
  const locationRef = useRef(location);
  const fareEstimateRequestRef = useRef(0);
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
    pollUserEvents();

    const interval = setInterval(() => {
      checkActiveRide();
      pollUserEvents();
    }, 5000);

    return () => clearInterval(interval);
  }, [user?.id]);

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
      const res = await fetch(url.toString(), { cache: 'no-store' });
      const data = await res.json();
      setNearbyDrivers(data);
    } catch {}
  };

  const checkActiveRide = async () => {
    if (!user?.id) return;
    try {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/rides/rider/${user.id}/active`, baseUrl);
      const res = await fetch(url.toString(), { cache: 'no-store' });
      const data = await res.json();
      if (data && data.id) {
        setActiveRide(data);
        if (data.status === 'requested') setPhase('waiting');
        else if (data.status === 'accepted' || data.status === 'arriving') {
          setPhase('matched');
          if (data.driverId) fetchDriverInfo(data.driverId);
        }
        else if (data.status === 'arrived' || data.status === 'in_progress') {
          setPhase('riding');
          if (data.driverId) fetchDriverInfo(data.driverId);
        }
        else if (data.status === 'completed') setPhase('completed');
      } else {
        const currentPhase = phaseRef.current;
        const currentRide = activeRideRef.current;
        if (currentPhase === 'waiting' || currentPhase === 'matched' || currentPhase === 'riding') {
          if (currentRide) {
            setActiveRide(currentRide);
            setPhase('completed');
          } else {
            setPhase('idle');
          }
        }
      }
    } catch {}
  };

  const pollUserEvents = async () => {
    if (!user?.id) return;

    try {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/events/${user.id}`, baseUrl);
      const res = await fetch(url.toString(), { cache: 'no-store' });
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
    if (!dropoffCoord || !location) return;
    setLoading(true);
    const requestId = ++fareEstimateRequestRef.current;

    try {
      const baseUrl = getApiUrl();
      const url = new URL(
        `/api/fare/estimate?pLat=${location.lat}&pLng=${location.lng}&dLat=${dropoffCoord.lat}&dLng=${dropoffCoord.lng}&additionalPassengers=${additionalPassengers}&rideType=${rideType}`,
        baseUrl
      );
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error('Fare estimate failed');

      const data = await res.json();

      if (requestId !== fareEstimateRequestRef.current) return;

      setFareEstimate(data);
      setPhase('confirming');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      if (requestId === fareEstimateRequestRef.current) {
        showAlert('Error', 'Could not get fare estimate');
      }
    } finally {
      if (requestId === fareEstimateRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const refreshFareEstimate = async (passengers: number, selectedRideType: 'private' | 'shared' = rideType) => {
    if (!location || !dropoffCoord) return;

    const requestId = ++fareEstimateRequestRef.current;

    try {
      const baseUrl = getApiUrl();
      const url = new URL(
        `/api/fare/estimate?pLat=${location.lat}&pLng=${location.lng}&dLat=${dropoffCoord.lat}&dLng=${dropoffCoord.lng}&additionalPassengers=${passengers}&rideType=${selectedRideType}`,
        baseUrl
      );

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error('Fare estimate failed');

      const data = await res.json();

      if (requestId === fareEstimateRequestRef.current) {
        setFareEstimate(data);
      }
    } catch {
      if (requestId === fareEstimateRequestRef.current) {
        showAlert('Error', 'Could not update the fare estimate');
      }
    }
  };

  const handleRequestRide = async () => {
    if (!location || !dropoffCoord || !user?.id) return;
    setLoading(true);
    try {
      const res = await apiRequest('POST', '/api/rides', {
        riderId: user.id,
        rideType,
        additionalPassengers,
        pickup: { lat: location.lat, lng: location.lng, address: pickupAddress },
        dropoff: { lat: dropoffCoord.lat, lng: dropoffCoord.lng, address: dropoffAddress },
      });
      const ride = await res.json();
      setActiveRide(ride);
      setPhase('waiting');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      showAlert('Error', e.message || 'Could not request ride');
    } finally {
      setLoading(false);
    }
  };

  const doCancelRide = async () => {
    if (!activeRide?.id) return;
    try {
      await apiRequest('PUT', `/api/rides/${activeRide.id}/status`, { status: 'cancelled' });
      setActiveRide(null);
      setPhase('idle');
      setDropoffCoord(null);
      setDropoffAddress('');
      setFareEstimate(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch {}
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
      await fetch(url.toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: reviewRating, comment: reviewComment.trim() || undefined }),
      });
      setReviewSubmitted(true);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
    menuActions.push({ label: 'Log Out', icon: 'log-out-outline', destructive: true, onPress: async () => { await logout(); router.replace('/'); } });
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

          {nearbyDrivers.map((driver) => (
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

          <Text style={styles.selectionLabel}>Choose your ride type</Text>
          <View style={styles.rideTypeOptions}>
            <Pressable
              style={[
                styles.rideTypeOption,
                rideType === 'private' && styles.rideTypeOptionSelected,
              ]}
              onPress={() => {
                setRideType('private');
                refreshFareEstimate(additionalPassengers, 'private');
              }}
            >
              <Ionicons
                name="car-sport"
                size={25}
                color={rideType === 'private' ? Colors.primary : Colors.textLight}
              />
              <Text style={[
                styles.rideTypeOptionTitle,
                rideType === 'private' && styles.rideTypeOptionTitleSelected,
              ]}>Private</Text>
              <Text style={styles.rideTypeOptionDescription}>
                Your group gets the vehicle
              </Text>
            </Pressable>

            <Pressable
              style={[
                styles.rideTypeOption,
                rideType === 'shared' && styles.rideTypeOptionSelected,
              ]}
              onPress={() => {
                setRideType('shared');
                refreshFareEstimate(additionalPassengers, 'shared');
              }}
            >
              <Ionicons
                name="people"
                size={25}
                color={rideType === 'shared' ? Colors.primary : Colors.textLight}
              />
              <Text style={[
                styles.rideTypeOptionTitle,
                rideType === 'shared' && styles.rideTypeOptionTitleSelected,
              ]}>Shared</Text>
              <Text style={styles.rideTypeOptionDescription}>
                Share available seats
              </Text>
            </Pressable>
          </View>

          <View style={styles.passengerSelector}>
            <View style={{ flex: 1 }}>
              <Text style={styles.selectionLabel}>Additional passengers</Text>
              <Text style={styles.passengerHint}>You are already counted as one passenger</Text>
            </View>
            <Pressable
              style={styles.passengerCounterButton}
              disabled={additionalPassengers === 0}
              onPress={() => {
                const next = Math.max(0, additionalPassengers - 1);
                setAdditionalPassengers(next);
                refreshFareEstimate(next);
              }}
            >
              <Ionicons name="remove" size={20} color={Colors.primary} />
            </Pressable>
            <Text style={styles.passengerCount}>{additionalPassengers}</Text>
            <Pressable
              style={styles.passengerCounterButton}
              disabled={additionalPassengers === 7}
              onPress={() => {
                const next = Math.min(7, additionalPassengers + 1);
                setAdditionalPassengers(next);
                refreshFareEstimate(next);
              }}
            >
              <Ionicons name="add" size={20} color={Colors.primary} />
            </Pressable>
          </View>

          <View style={styles.fareCard}>
            <View style={styles.fareMain}>
              <Text style={styles.fareLabel}>Estimated Fare</Text>
              <Text style={styles.farePrice}>M{fareEstimate.totalFare.toFixed(2)}</Text>
            </View>
            <View style={styles.fareDetails}>
              <FareRow label="Base fare" value={`M${fareEstimate.baseFare.toFixed(2)}`} />
              <FareRow label={`Distance (${fareEstimate.distance} KM)`} value={`M${fareEstimate.distanceFare.toFixed(2)}`} />
              <FareRow label={`Time (~${fareEstimate.duration} min)`} value={`M${fareEstimate.timeFare.toFixed(2)}`} />
              {additionalPassengers > 0 && (
                <FareRow
                  label={`Additional passengers (${additionalPassengers})`}
                  value={`M${(fareEstimate.passengerFare || 0).toFixed(2)}`}
                />
              )}
              {additionalPassengers > 0 && (fareEstimate.sharedDiscount || 0) > 0 && (
                <FareRow
                  label={`Group discount (${fareEstimate.groupDiscountPercent}%)`}
                  value={`-M${fareEstimate.sharedDiscount.toFixed(2)}`}
                />
              )}
              </View>
          </View>

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
            <Text style={styles.waitingTitle}>Finding your driver...</Text>
            <Text style={styles.waitingSubtitle}>Looking for nearby available drivers</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.cancelRideBtn, pressed && styles.btnPressed]}
            onPress={handleCancelRide}
          >
            <Text style={styles.cancelRideBtnText}>Cancel Ride</Text>
          </Pressable>
        </Animated.View>
      )}

      {(phase === 'matched' || phase === 'riding') && activeRide && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />

          <View style={styles.rideStatusBar}>
            <View style={[styles.rideStatusDot, { backgroundColor: phase === 'riding' ? Colors.primary : Colors.warning }]} />
            <Text style={styles.rideStatusText}>
              {activeRide.status === 'accepted' && 'Driver on the way'}
              {activeRide.status === 'arriving' && 'Driver is arriving'}
              {activeRide.status === 'arrived' && 'Driver has arrived'}
              {activeRide.status === 'in_progress' && 'Ride in progress'}
            </Text>
          </View>

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

          {activeRide.fare && (
            <View style={styles.rideFareRow}>
              <Text style={styles.rideFareLabel}>Fare</Text>
              <Text style={styles.rideFareValue}>M{activeRide.fare.totalFare.toFixed(2)}</Text>
            </View>
          )}

          <Pressable
            style={({ pressed }) => [styles.cancelRideBtn, pressed && styles.btnPressed]}
            onPress={handleCancelRide}
          >
            <Text style={styles.cancelRideBtnText}>Cancel Ride</Text>
          </Pressable>
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
                <Text style={styles.completedFare}>M{activeRide.fare.totalFare.toFixed(2)}</Text>
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
  selectionLabel: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text,
    marginBottom: 8,
  },
  rideTypeOptions: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  rideTypeOption: {
    flex: 1,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    gap: 5,
  },
  rideTypeOptionSelected: {
    borderColor: Colors.primary,
    backgroundColor: 'rgba(54, 214, 197, 0.10)',
  },
  rideTypeOptionTitle: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text,
  },
  rideTypeOptionTitleSelected: {
    color: Colors.primary,
  },
  rideTypeOptionDescription: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
  passengerSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  passengerHint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
  passengerCounterButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  passengerCount: {
    minWidth: 18,
    textAlign: 'center',
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    color: Colors.text,
  },
  fareCard: {
    backgroundColor: Colors.background, borderRadius: 16, padding: 16, marginBottom: 16,
  },
  fareMain: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12,
  },
  fareLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  farePrice: {
    fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text,
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
  waitingContent: {
    alignItems: 'center', gap: 12, paddingVertical: 20,
  },
  waitingTitle: {
    fontSize: 18, fontFamily: 'Inter_600SemiBold', color: Colors.text,
  },
  waitingSubtitle: {
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
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
