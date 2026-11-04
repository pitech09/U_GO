import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform,
  ActivityIndicator, Dimensions, ScrollView, Linking, TextInput,
} from 'react-native';
import { router } from 'expo-router';
import MapView, {
  Marker,
  PROVIDER_DEFAULT,
  CartoTileLayer,
} from '@/components/MapView';
import * as Location from 'expo-location';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest, getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';
import Animated, { SlideInDown, FadeIn, FadeInUp, FadeInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { Ride } from '@shared/schema';
import { startIncomingRideAlert, stopIncomingRideAlert } from '@/lib/sound-notifications';
import AppModal, { useAppModal } from '@/components/AppModal';

const { width } = Dimensions.get('window');
const LATITUDE_DELTA = 0.015;
const LONGITUDE_DELTA = LATITUDE_DELTA * (width / Dimensions.get('window').height);

type DriverPhase = 'dashboard' | 'online' | 'ride_request' | 'navigating' | 'arrived' | 'in_ride';
type DriverRideOffer = Ride & { offerExpiresAt: number };

export default function DriverScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout, refreshUser } = useAuth();
  const mapRef = useRef<MapView>(null);
  const alertedRideIdsRef = useRef<Set<string>>(new Set());
  const previousAvailableRideIdsRef = useRef<Set<string>>(new Set());

  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(user?.isOnline || false);
  const [phase, setPhase] = useState<DriverPhase>('dashboard');
  const [pendingRides, setPendingRides] = useState<DriverRideOffer[]>([]);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [activeRide, setActiveRide] = useState<Ride | null>(null);
  const [earnings, setEarnings] = useState({ today: 0, total: user?.totalEarnings || 0, rides: user?.totalRides || 0 });
  const [rideHistory, setRideHistory] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(false);
  const [vehicleEditorOpen, setVehicleEditorOpen] = useState(false);
  const [savingVehicle, setSavingVehicle] = useState(false);
  const [vehicleForm, setVehicleForm] = useState({
    make: '',
    model: '',
    year: '',
    color: '',
    plate: '',
    seatingCapacity: '',
  });
  const { showAlert, showActionSheet, modalProps } = useAppModal();

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  useEffect(() => {
    requestLocation();
  }, []);

  useEffect(() => {
    return () => {
      stopIncomingRideAlert();
    };
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    fetchRideHistory();
    checkActiveRide();
    refreshUser();

    const interval = setInterval(() => {
      checkActiveRide();
        if (isOnline) fetchPendingRides();
    }, 4000);

    return () => clearInterval(interval);
  }, [user?.id, isOnline]);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setEarnings({
      today: earnings.today,
      total: user?.totalEarnings || 0,
      rides: user?.totalRides || 0,
    });
  }, [user?.totalEarnings, user?.totalRides]);

  useEffect(() => {
    if (location && user?.id) {
      updateServerLocation();
      const interval = setInterval(updateServerLocation, 8000);
      return () => clearInterval(interval);
    }
  }, [location, user?.id]);

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
  };

  const updateServerLocation = async () => {
    if (!user?.id || !location) return;
    try {
      await apiRequest('PUT', `/api/user/${user.id}/location`, location);
    } catch {}
  };

  const openVehicleEditor = () => {
    setVehicleForm({
      make: user?.vehicleInfo?.make || '',
      model: user?.vehicleInfo?.model || '',
      year: user?.vehicleInfo?.year || '',
      color: user?.vehicleInfo?.color || '',
      plate: user?.vehicleInfo?.plate || '',
      seatingCapacity: user?.vehicleInfo?.seatingCapacity?.toString() || '',
    });
    setVehicleEditorOpen(true);
  };

  const saveVehicle = async () => {
    if (!user?.id) return;

    const capacity = Number(vehicleForm.seatingCapacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
      showAlert(
        'Invalid capacity',
        'Enter between 1 and 8 passenger seats, excluding the driver.'
      );
      return;
    }

    const vehicleInfo = {
      make: vehicleForm.make.trim(),
      model: vehicleForm.model.trim(),
      year: vehicleForm.year.trim(),
      color: vehicleForm.color.trim(),
      plate: vehicleForm.plate.trim(),
      seatingCapacity: capacity,
    };

    if (
      !vehicleInfo.make ||
      !vehicleInfo.model ||
      !vehicleInfo.year ||
      !vehicleInfo.color ||
      !vehicleInfo.plate
    ) {
      showAlert('Missing details', 'Please complete all vehicle fields.');
      return;
    }

    setSavingVehicle(true);
    try {
      await apiRequest('PUT', `/api/user/${user.id}/vehicle`, { vehicleInfo });
      await refreshUser();
      setVehicleEditorOpen(false);
      showAlert('Vehicle updated', 'Your vehicle details and passenger capacity have been saved.');
    } catch (e: any) {
      showAlert('Could not save vehicle', e?.message || 'Please try again.');
    } finally {
      setSavingVehicle(false);
    }
  };

  const toggleOnline = async () => {
    if (!user?.id) return;
    const newState = !isOnline;

    if (newState) {
      const capacity = Number(user.vehicleInfo?.seatingCapacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
        openVehicleEditor();
        showAlert(
          'Vehicle details required',
          'Add or update your vehicle and passenger seating capacity before going online.'
        );
        return;
      }
    }

    try {
      if (newState && location) {
        await apiRequest('PUT', `/api/user/${user.id}/location`, location);
      }
      await apiRequest('PUT', `/api/user/${user.id}/online`, { isOnline: newState });
      setIsOnline(newState);
      if (newState) {
        setPhase('online');
        fetchPendingRides();
      } else {
        setPhase('dashboard');
        alertedRideIdsRef.current.clear();
        previousAvailableRideIdsRef.current.clear();
        stopIncomingRideAlert();
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (e: any) {
      showAlert('Could not update status', e.message || 'Please try again.');
    }
  };

  const fetchPendingRides = async () => {
    if (!user?.id) return;

    try {
      const res = await apiRequest(
        'GET',
        `/api/rides/driver/${user.id}/offers`
      );
      const data = await res.json();
      const offers: DriverRideOffer[] = Array.isArray(data) ? data : [];
      const validOffers = offers.filter(
        offer => offer.offerExpiresAt > Date.now()
      );

      setPendingRides(validOffers);

      const availableIds = new Set(validOffers.map(offer => offer.id));
      const hasNewRide = [...availableIds].some(
        rideId => !previousAvailableRideIdsRef.current.has(rideId)
      );

      alertedRideIdsRef.current = availableIds;
      previousAvailableRideIdsRef.current = availableIds;

      if (isOnline && hasNewRide) {
        startIncomingRideAlert();
      }

      if (availableIds.size === 0) {
        stopIncomingRideAlert();
      }
    } catch {}
  };

  const checkActiveRide = async () => {
    if (!user?.id) return;
    try {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/rides/driver/${user.id}/active`, baseUrl);
      const res = await fetch(url.toString(), { cache: 'no-store' });
      const data = await res.json();
      if (data && data.id) {
        setActiveRide(data);
        setPendingRides([]);
        alertedRideIdsRef.current.clear();
        previousAvailableRideIdsRef.current.clear();
        stopIncomingRideAlert();

        if (data.status === 'accepted' || data.status === 'arriving') setPhase('navigating');
        else if (data.status === 'arrived') setPhase('arrived');
        else if (data.status === 'in_progress') setPhase('in_ride');
      }
    } catch {}
  };

  const fetchRideHistory = async () => {
    if (!user?.id) return;
    try {
      const res = await apiRequest('GET', `/api/rides/driver/${user.id}`);
      const data = await res.json();
      setRideHistory(data);
      const todayEarnings = data
        .filter((r: Ride) => {
          if (r.status !== 'completed' || !r.completedAt) return false;
          const d = new Date(r.completedAt);
          const now = new Date();
          return d.toDateString() === now.toDateString();
        })
        .reduce((sum: number, r: Ride) => sum + (r.fare?.driverEarnings || 0), 0);
      setEarnings(prev => ({ ...prev, today: todayEarnings }));
    } catch {}
  };

  const acceptRide = async (rideId: string) => {
    if (!user?.id) return;
    setLoading(true);
    try {
      alertedRideIdsRef.current.clear();
      previousAvailableRideIdsRef.current.clear();
      stopIncomingRideAlert();

      const res = await apiRequest('PUT', `/api/rides/${rideId}/accept`, { driverId: user.id });
      const ride = await res.json();
      setPendingRides([]);
      setActiveRide(ride);
      setPhase('navigating');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      await apiRequest('PUT', `/api/rides/${rideId}/status`, { status: 'arriving' });
    } catch (e: any) {
      const msg = e.message || 'Could not accept ride';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };

  const rejectRide = async (rideId: string) => {
    if (!user?.id) return;

    try {
      await apiRequest('PUT', `/api/rides/${rideId}/reject`, {
        driverId: user.id,
      });

      setPendingRides(previous => previous.filter(ride => ride.id !== rideId));
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await fetchPendingRides();
    } catch (e: any) {
      showAlert('Offer unavailable', e.message || 'Could not reject this offer');
      await fetchPendingRides();
    }
  };

  const updateRideStatus = async (status: string) => {
    if (!activeRide?.id) return;
    setLoading(true);
    try {
      const res = await apiRequest('PUT', `/api/rides/${activeRide.id}/status`, { status });
      const updated = await res.json();
      setActiveRide(updated);

      if (status === 'arrived') setPhase('arrived');
      else if (status === 'in_progress') setPhase('in_ride');
      else if (status === 'completed') {
        setPhase(isOnline ? 'online' : 'dashboard');
        setActiveRide(null);
        fetchRideHistory();
        refreshUser();
        if (updated.fare) {
          setEarnings(prev => ({
            today: prev.today + updated.fare.driverEarnings,
            total: prev.total + updated.fare.driverEarnings,
            rides: prev.rides + 1,
          }));
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (e: any) {
      const msg = e.message || 'Could not update status';
      showAlert('Error', msg);
    } finally {
      setLoading(false);
    }
  };

  const openNavigationApp = (lat: number, lng: number, label: string) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${label}@${lat},${lng}`,
      android: `geo:${lat},${lng}?q=${lat},${lng}(${label})`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    });
    if (url) Linking.openURL(url);
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
        <Text style={styles.loadingText}>Location access is required to drive</Text>
        <Pressable style={styles.permBtn} onPress={requestLocation}>
          <Text style={styles.permBtnText}>Grant Permission</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'dashboard' && !isOnline) {
    return (
      <View style={[styles.dashContainer, { paddingTop: topInset }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: bottomInset + 24 }}>
          <View style={styles.dashHeader}>
            <View>
              <Text style={styles.dashGreeting}>Welcome back,</Text>
              <Text style={styles.dashName}>{user?.fullName || 'Driver'}</Text>
            </View>
            <View style={styles.headerActions}>
              <Pressable
                style={styles.switchModeBtn}
                onPress={() => router.replace('/rider')}
              >
                <Ionicons name="person" size={16} color="#007AFF" />
                <Text style={styles.switchModeText}>Ride</Text>
              </Pressable>
              <Pressable
                style={styles.profileBtn}
                onPress={() => {
                  const actions: { label: string; icon: string; iconColor?: string; onPress: () => void; destructive?: boolean }[] = [];
                  if (user?.role === 'admin') {
                    actions.push({ label: 'Admin Panel', icon: 'settings', iconColor: Colors.accent, onPress: () => router.replace('/admin') });
                  }
                  actions.push({ label: 'Switch to Rider', icon: 'person', onPress: () => router.replace('/rider') });
                  actions.push({ label: 'Log Out', icon: 'log-out-outline', destructive: true, onPress: () => { logout(); router.replace('/'); } });
                  showActionSheet('Account', actions);
                }}
              >
                <Ionicons name="person-circle-outline" size={32} color={Colors.textLight} />
              </Pressable>
            </View>
          </View>

          <View style={styles.earningsCard}>
            <Text style={styles.earningsLabel}>Today&apos;s Earnings</Text>
            <Text style={styles.earningsAmount}>M{earnings.today.toFixed(2)}</Text>
            <View style={styles.earningsRow}>
              <View style={styles.earningsStat}>
                <Text style={styles.earningsStatValue}>M{earnings.total.toFixed(2)}</Text>
                <Text style={styles.earningsStatLabel}>Total</Text>
              </View>
              <View style={styles.earningsDivider} />
              <View style={styles.earningsStat}>
                <Text style={styles.earningsStatValue}>{earnings.rides}</Text>
                <Text style={styles.earningsStatLabel}>Rides</Text>
              </View>
              <View style={styles.earningsDivider} />
              <View style={styles.earningsStat}>
                <Text style={styles.earningsStatValue}>{(user?.rating || 5.0).toFixed(1)}</Text>
                <Text style={styles.earningsStatLabel}>Rating</Text>
              </View>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [styles.goOnlineBtn, pressed && styles.btnPressed]}
            onPress={toggleOnline}
          >
            <Ionicons name="power" size={24} color={Colors.secondary} />
            <Text style={styles.goOnlineBtnText}>Go Online</Text>
          </Pressable>

          <View style={styles.vehicleSection}>
            <View style={styles.vehicleCard}>
              <Ionicons name="car" size={24} color={Colors.primary} />
              <View style={styles.vehicleInfo}>
                <Text style={styles.vehicleTitle}>
                  {user?.vehicleInfo
                    ? `${user.vehicleInfo.year} ${user.vehicleInfo.make} ${user.vehicleInfo.model}`
                    : 'Vehicle details required'}
                </Text>
                <Text style={styles.vehicleSub}>
                  {user?.vehicleInfo
                    ? `${user.vehicleInfo.color} | ${user.vehicleInfo.plate}`
                    : 'Add your vehicle before going online'}
                </Text>
                <Text style={styles.vehicleCapacity}>
                  Passenger seats: {user?.vehicleInfo?.seatingCapacity || 'Not verified'}
                  {user?.vehicleInfo?.seatingCapacity ? ' (excluding driver)' : ''}
                </Text>
              </View>
              <Pressable onPress={openVehicleEditor} style={styles.editVehicleBtn}>
                <Ionicons name="create-outline" size={20} color={Colors.primary} />
                <Text style={styles.editVehicleText}>
                  {user?.vehicleInfo ? 'Edit' : 'Add'}
                </Text>
              </Pressable>
            </View>

            {vehicleEditorOpen && (
              <View style={styles.vehicleEditor}>
                <Text style={styles.vehicleEditorTitle}>Vehicle information</Text>
                <Text style={styles.vehicleEditorNote}>
                  Passenger capacity excludes the driver. Enter the number of passenger seats.
                </Text>

                <TextInput
                  style={styles.vehicleInput}
                  placeholder="Vehicle make"
                  placeholderTextColor={Colors.textLight}
                  value={vehicleForm.make}
                  onChangeText={value => setVehicleForm(f => ({ ...f, make: value }))}
                />
                <TextInput
                  style={styles.vehicleInput}
                  placeholder="Vehicle model"
                  placeholderTextColor={Colors.textLight}
                  value={vehicleForm.model}
                  onChangeText={value => setVehicleForm(f => ({ ...f, model: value }))}
                />
                <TextInput
                  style={styles.vehicleInput}
                  placeholder="Year"
                  placeholderTextColor={Colors.textLight}
                  value={vehicleForm.year}
                  onChangeText={value => setVehicleForm(f => ({ ...f, year: value }))}
                />
                <TextInput
                  style={styles.vehicleInput}
                  placeholder="Colour"
                  placeholderTextColor={Colors.textLight}
                  value={vehicleForm.color}
                  onChangeText={value => setVehicleForm(f => ({ ...f, color: value }))}
                />
                <TextInput
                  style={styles.vehicleInput}
                  placeholder="Registration plate"
                  placeholderTextColor={Colors.textLight}
                  autoCapitalize="characters"
                  value={vehicleForm.plate}
                  onChangeText={value => setVehicleForm(f => ({ ...f, plate: value }))}
                />
                <TextInput
                  style={styles.vehicleInput}
                  placeholder="Passenger seats (1-8)"
                  placeholderTextColor={Colors.textLight}
                  keyboardType="number-pad"
                  value={vehicleForm.seatingCapacity}
                  onChangeText={value => setVehicleForm(f => ({ ...f, seatingCapacity: value }))}
                />

                <View style={styles.vehicleEditorActions}>
                  <Pressable
                    style={styles.vehicleCancelBtn}
                    onPress={() => setVehicleEditorOpen(false)}
                    disabled={savingVehicle}
                  >
                    <Text style={styles.vehicleCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.vehicleSaveBtn, savingVehicle && { opacity: 0.6 }]}
                    onPress={saveVehicle}
                    disabled={savingVehicle}
                  >
                    {savingVehicle
                      ? <ActivityIndicator color={Colors.secondary} />
                      : <Text style={styles.vehicleSaveText}>Save vehicle</Text>}
                  </Pressable>
                </View>
              </View>
            )}
          </View>

          {rideHistory.length > 0 && (
            <View style={styles.historySection}>
              <Text style={styles.historyTitle}>Recent Rides</Text>
              {rideHistory.slice(0, 5).map((ride) => (
                <View key={ride.id} style={styles.historyItem}>
                  <View style={styles.historyIcon}>
                    <Ionicons
                      name={ride.status === 'completed' ? 'checkmark-circle' : 'close-circle'}
                      size={20}
                      color={ride.status === 'completed' ? Colors.success : Colors.error}
                    />
                  </View>
                  <View style={styles.historyDetails}>
                    <Text style={styles.historyRoute} numberOfLines={1}>
                      {ride.pickup.address} → {ride.dropoff.address}
                    </Text>
                    <Text style={styles.historyTime}>
                      {new Date(ride.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  {ride.fare && (
                    <Text style={styles.historyEarning}>
                      +M{ride.fare.driverEarnings.toFixed(2)}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}

          <View style={styles.compSection}>
            <Text style={styles.compTitle}>Your Compensation</Text>
            <View style={styles.compCard}>
              <View style={styles.compRow}>
                <Text style={styles.compLabel}>Your share</Text>
                <Text style={styles.compValue}>88%</Text>
              </View>
              <View style={styles.compBar}>
                <View style={[styles.compFill, { width: '88%' }]} />
              </View>
              <Text style={styles.compNote}>
                You keep 88% of every fare - higher than industry average
              </Text>
            </View>
          </View>
        </ScrollView>
        <AppModal {...modalProps} />
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
        >
          <CartoTileLayer />

          {activeRide && (
            <>
              <Marker
                coordinate={{
                  latitude: activeRide.pickup.lat,
                  longitude: activeRide.pickup.lng,
                }}
                title="Pickup"
              >
                <View style={styles.pickupMarker}>
                  <Ionicons name="person" size={14} color={Colors.textWhite} />
                </View>
              </Marker>
              <Marker
                coordinate={{
                  latitude: activeRide.dropoff.lat,
                  longitude: activeRide.dropoff.lng,
                }}
                title="Drop-off"
              >
                <View style={styles.dropoffMarker}>
                  <Ionicons name="flag" size={14} color={Colors.textWhite} />
                </View>
              </Marker>
            </>
          )}

          {pendingRides.map(ride => (
            <Marker
              key={ride.id}
              coordinate={{ latitude: ride.pickup.lat, longitude: ride.pickup.lng }}
              title={ride.riderName || 'Rider'}
            >
              <View style={styles.rideRequestMarker}>
                <Ionicons name="person" size={12} color={Colors.textWhite} />
              </View>
            </Marker>
          ))}
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
        <Pressable
          style={[styles.onlineToggle, !isOnline && styles.offlineToggle]}
          onPress={toggleOnline}
        >
          <View style={[styles.onlineDot, !isOnline && styles.offlineDot]} />
          <Text style={[styles.onlineText, !isOnline && styles.offlineText]}>
            {isOnline ? 'Online' : 'Offline'}
          </Text>
        </Pressable>

        {activeRide?.fare && (
          <View style={styles.earningChip}>
            <Ionicons name="cash" size={16} color={Colors.primary} />
            <Text style={styles.earningChipText}>M{activeRide.fare.driverEarnings.toFixed(2)}</Text>
          </View>
        )}
      </View>

      {phase === 'online' && pendingRides.length > 0 && (
        <Animated.View
          entering={SlideInDown.duration(400)}
          style={[styles.bottomCard, { paddingBottom: bottomInset + 12, maxHeight: '68%' }]}
        >
          <View style={styles.cardHandle} />
          <View style={styles.offerHeader}>
            <Text style={styles.cardTitle}>Ride Offers</Text>
            <Text style={styles.offerCount}>{pendingRides.length}/5</Text>
          </View>

          <ScrollView
            style={styles.offerList}
            contentContainerStyle={styles.offerListContent}
            showsVerticalScrollIndicator
            nestedScrollEnabled
          >
            {pendingRides.map(ride => {
              const secondsLeft = Math.max(
                0,
                Math.ceil((ride.offerExpiresAt - currentTime) / 1000)
              );

              return (
                <View key={ride.id} style={styles.requestCard}>
                  <View style={styles.offerTopRow}>
                    <View style={[
                      styles.rideTypeBadge,
                      ride.rideType === 'shared' && styles.sharedRideBadge,
                    ]}>
                      <Text style={styles.rideTypeText}>
                        {ride.rideType === 'shared' ? 'SHARED' : 'PRIVATE'}
                      </Text>
                    </View>
                    <Text style={[
                      styles.offerCountdown,
                      secondsLeft <= 10 && styles.offerCountdownUrgent,
                    ]}>
                      <Ionicons name="timer-outline" size={13} /> {secondsLeft}s left
                    </Text>
                  </View>

                  <View style={styles.requestRoute}>
                    <View style={styles.routePoint}>
                      <View style={styles.greenDot} />
                      <Text style={styles.routeAddr} numberOfLines={1}>{ride.pickup.address}</Text>
                    </View>
                    <View style={styles.routeLine} />
                    <View style={styles.routePoint}>
                      <View style={styles.orangeDot} />
                      <Text style={styles.routeAddr} numberOfLines={1}>{ride.dropoff.address}</Text>
                    </View>
                  </View>

                  <View style={styles.offerMetaRow}>
                    <Text style={styles.offerMetaText}>
                      <Ionicons name="people-outline" size={14} /> {ride.passengerCount || 1} passenger{(ride.passengerCount || 1) === 1 ? '' : 's'}
                    </Text>
                    <Text style={styles.offerMetaText}>
                      <Ionicons name="navigate-outline" size={14} /> {Number(ride.distance || 0).toFixed(1)} km
                    </Text>
                  </View>

                  <View style={styles.requestFare}>
                    <View>
                      <Text style={styles.requestFareLabel}>Your earnings</Text>
                      <Text style={styles.requestFareAmount}>
                        M{(ride.fare?.driverEarnings || 0).toFixed(2)}
                      </Text>
                    </View>
                    <Text style={styles.offerFareTotal}>
                      Fare M{(ride.fare?.totalFare || 0).toFixed(2)}
                    </Text>
                  </View>

                  <View style={styles.offerActions}>
                    <Pressable
                      style={({ pressed }) => [
                        styles.rejectBtn,
                        pressed && styles.btnPressed,
                        loading && styles.btnDisabled,
                      ]}
                      onPress={() => rejectRide(ride.id)}
                      disabled={loading}
                    >
                      <Ionicons name="close" size={18} color={Colors.text} />
                      <Text style={styles.rejectBtnText}>Reject</Text>
                    </Pressable>

                    <Pressable
                      style={({ pressed }) => [
                        styles.acceptBtn,
                        styles.offerAcceptBtn,
                        pressed && styles.btnPressed,
                        loading && styles.btnDisabled,
                      ]}
                      onPress={() => acceptRide(ride.id)}
                      disabled={loading || secondsLeft === 0}
                    >
                      {loading ? (
                        <ActivityIndicator size="small" color={Colors.secondary} />
                      ) : (
                        <>
                          <Ionicons name="checkmark" size={18} color={Colors.secondary} />
                          <Text style={styles.acceptBtnText}>Accept</Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </Animated.View>
      )}

      {phase === 'online' && pendingRides.length === 0 && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />
          <View style={styles.waitingContent}>
            <ActivityIndicator size="small" color={Colors.primary} />
            <Text style={styles.waitingText}>Waiting for ride requests...</Text>
          </View>
        </Animated.View>
      )}

      {phase === 'navigating' && activeRide && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />
          <View style={styles.rideStatusHeader}>
            <View style={[styles.statusIndicator, { backgroundColor: Colors.warning }]} />
            <Text style={styles.cardTitle}>Navigate to Pickup</Text>
          </View>
          <Text style={styles.rideAddress} numberOfLines={2}>{activeRide.pickup.address}</Text>

          <View style={styles.actionRow}>
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && styles.btnPressed]}
              onPress={() => openNavigationApp(activeRide.pickup.lat, activeRide.pickup.lng, 'Pickup')}
            >
              <Ionicons name="navigate" size={20} color={Colors.textWhite} />
              <Text style={styles.navBtnText}>Navigate</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.arrivedBtn, pressed && styles.btnPressed, loading && styles.btnDisabled]}
              onPress={() => updateRideStatus('arrived')}
              disabled={loading}
            >
              <Ionicons name="flag" size={20} color={Colors.secondary} />
              <Text style={styles.arrivedBtnText}>I&apos;ve Arrived</Text>
            </Pressable>
          </View>
        </Animated.View>
      )}

      {phase === 'arrived' && activeRide && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />
          <View style={styles.rideStatusHeader}>
            <View style={[styles.statusIndicator, { backgroundColor: Colors.primary }]} />
            <Text style={styles.cardTitle}>Waiting for Rider</Text>
          </View>
          <Text style={styles.rideInfo}>
            {activeRide.riderName || 'Rider'} has been notified of your arrival
          </Text>
          <Pressable
            style={({ pressed }) => [styles.startRideBtn, pressed && styles.btnPressed, loading && styles.btnDisabled]}
            onPress={() => updateRideStatus('in_progress')}
            disabled={loading}
          >
            <Ionicons name="car" size={20} color={Colors.secondary} />
            <Text style={styles.startRideBtnText}>Start Ride</Text>
          </Pressable>
        </Animated.View>
      )}

      {phase === 'in_ride' && activeRide && (
        <Animated.View entering={SlideInDown.duration(400)} style={[styles.bottomCard, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.cardHandle} />
          <View style={styles.rideStatusHeader}>
            <View style={[styles.statusIndicator, { backgroundColor: Colors.success }]} />
            <Text style={styles.cardTitle}>Ride in Progress</Text>
          </View>

          <View style={styles.rideDestination}>
            <Ionicons name="flag" size={18} color={Colors.accent} />
            <Text style={styles.rideDestText} numberOfLines={2}>{activeRide.dropoff.address}</Text>
          </View>

          <View style={styles.actionRow}>
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && styles.btnPressed]}
              onPress={() => openNavigationApp(activeRide.dropoff.lat, activeRide.dropoff.lng, 'Dropoff')}
            >
              <Ionicons name="navigate" size={20} color={Colors.textWhite} />
              <Text style={styles.navBtnText}>Navigate</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.completeBtn, pressed && styles.btnPressed, loading && styles.btnDisabled]}
              onPress={() => updateRideStatus('completed')}
              disabled={loading}
            >
              <Ionicons name="checkmark-circle" size={20} color={Colors.secondary} />
              <Text style={styles.completeBtnText}>Complete Ride</Text>
            </Pressable>
          </View>

          {activeRide.fare && (
            <View style={styles.rideEarnings}>
              <Text style={styles.rideEarningsLabel}>You&apos;ll earn</Text>
              <Text style={styles.rideEarningsValue}>M{activeRide.fare.driverEarnings.toFixed(2)}</Text>
            </View>
          )}
        </Animated.View>
      )}
      <AppModal {...modalProps} />
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
  dashContainer: {
    flex: 1, backgroundColor: Colors.backgroundDark, paddingHorizontal: 20,
  },
  dashHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 16, marginBottom: 24,
  },
  dashGreeting: {
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  dashName: {
    fontSize: 24, fontFamily: 'Inter_700Bold', color: Colors.textWhite, marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row', gap: 8, alignItems: 'center',
  },
  switchModeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,122,255,0.12)',
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
  },
  switchModeText: {
    fontSize: 13, fontFamily: 'Inter_600SemiBold', color: '#007AFF',
  },
  profileBtn: { padding: 4 },
  earningsCard: {
    backgroundColor: 'rgba(54, 214, 197, 0.08)', borderRadius: 20, padding: 24, marginBottom: 20,
    borderWidth: 1, borderColor: 'rgba(54, 214, 197, 0.15)',
  },
  earningsLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.primary, marginBottom: 4,
  },
  earningsAmount: {
    fontSize: 44, fontFamily: 'Inter_700Bold', color: Colors.textWhite, marginBottom: 16,
  },
  earningsRow: {
    flexDirection: 'row', justifyContent: 'space-around',
  },
  earningsStat: { alignItems: 'center' },
  earningsStatValue: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.textWhite,
  },
  earningsStatLabel: {
    fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.textLight, marginTop: 2,
  },
  earningsDivider: {
    width: 1, height: 30, backgroundColor: 'rgba(255,255,255,0.1)',
  },
  goOnlineBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: Colors.primary, paddingVertical: 18, borderRadius: 16, marginBottom: 20,
  },
  goOnlineBtnText: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.secondary,
  },
  vehicleCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16, padding: 16, marginBottom: 20,
  },
  vehicleInfo: { flex: 1 },
  vehicleCapacity: {
    fontSize: 12, fontFamily: 'Inter_600SemiBold',
    color: Colors.primary, marginTop: 5,
  },
  editVehicleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    padding: 8,
  },
  editVehicleText: {
    fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.primary,
  },
  vehicleSection: { marginBottom: 20 },
  vehicleEditor: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16, padding: 16, marginTop: 4,
  },
  vehicleEditorTitle: {
    fontSize: 17, fontFamily: 'Inter_700Bold',
    color: Colors.textWhite, marginBottom: 6,
  },
  vehicleEditorNote: {
    fontSize: 12, fontFamily: 'Inter_400Regular',
    color: Colors.textLight, marginBottom: 14, lineHeight: 18,
  },
  vehicleInput: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12,
    color: Colors.textWhite, fontSize: 14, marginBottom: 10,
  },
  vehicleEditorActions: {
    flexDirection: 'row', justifyContent: 'flex-end',
    alignItems: 'center', gap: 10, marginTop: 6,
  },
  vehicleCancelBtn: {
    paddingVertical: 12, paddingHorizontal: 16,
    borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)',
  },
  vehicleCancelText: {
    color: Colors.textWhite, fontFamily: 'Inter_600SemiBold',
  },
  vehicleSaveBtn: {
    paddingVertical: 12, paddingHorizontal: 18,
    borderRadius: 10, backgroundColor: Colors.primary,
    minWidth: 120, alignItems: 'center',
  },
  vehicleSaveText: {
    color: Colors.secondary, fontFamily: 'Inter_700Bold',
  },
  vehicleTitle: {
    fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.textWhite,
  },
  vehicleSub: {
    fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.textLight, marginTop: 2,
  },
  historySection: { marginBottom: 20 },
  historyTitle: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.textWhite, marginBottom: 12,
  },
  historyItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14, padding: 14, marginBottom: 8,
  },
  historyIcon: {},
  historyDetails: { flex: 1 },
  historyRoute: {
    fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.textWhite,
  },
  historyTime: {
    fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.textLight, marginTop: 2,
  },
  historyEarning: {
    fontSize: 15, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  compSection: { marginBottom: 20 },
  compTitle: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.textWhite, marginBottom: 12,
  },
  compCard: {
    backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 16, padding: 16,
  },
  compRow: {
    flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10,
  },
  compLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  compValue: {
    fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  compBar: {
    height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.1)', marginBottom: 10,
  },
  compFill: {
    height: 8, borderRadius: 4, backgroundColor: Colors.primary,
  },
  compNote: {
    fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  topBar: {
    position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', zIndex: 10,
  },
  onlineToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(52, 199, 89, 0.15)',
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(52, 199, 89, 0.3)',
  },
  offlineToggle: {
    backgroundColor: 'rgba(255, 59, 48, 0.15)', borderColor: 'rgba(255, 59, 48, 0.3)',
  },
  onlineDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.driverOnline,
  },
  offlineDot: {
    backgroundColor: Colors.driverOffline,
  },
  onlineText: {
    fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.driverOnline,
  },
  offlineText: {
    color: Colors.driverOffline,
  },
  earningChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.mapOverlay,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 4,
  },
  earningChipText: {
    fontSize: 15, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  bottomCard: {
    position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: Colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 16, elevation: 10,
  },
  cardHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: 'center', marginBottom: 16,
  },
  cardTitle: {
    fontSize: 20, fontFamily: 'Inter_700Bold', color: Colors.text, marginBottom: 12,
  },
  offerHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  offerCount: {
    fontSize: 13, fontFamily: 'Inter_700Bold', color: Colors.primary,
    backgroundColor: Colors.background, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 12, overflow: 'hidden',
  },
  offerList: {
    flexGrow: 0,
  },
  offerListContent: {
    gap: 12, paddingBottom: 8,
  },
  offerTopRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  rideTypeBadge: {
    backgroundColor: Colors.background, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 8,
  },
  sharedRideBadge: {
    backgroundColor: '#D9F7F2',
  },
  rideTypeText: {
    fontSize: 11, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  offerCountdown: {
    fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.primary,
  },
  offerCountdownUrgent: {
    color: Colors.accent,
  },
  offerMetaRow: {
    flexDirection: 'row', justifyContent: 'space-between',
  },
  offerMetaText: {
    fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  offerFareTotal: {
    fontSize: 13, fontFamily: 'Inter_600SemiBold', color: Colors.text,
    alignSelf: 'center',
  },
  offerActions: {
    flexDirection: 'row', gap: 10,
  },
  rejectBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, backgroundColor: Colors.background, paddingVertical: 13, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  rejectBtnText: {
    fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.text,
  },
  offerAcceptBtn: {
    flex: 2, paddingVertical: 13,
  },
  requestCard: { gap: 14 },
  requestRoute: { gap: 4 },
  routePoint: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  greenDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  orangeDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.accent },
  routeLine: { width: 2, height: 12, backgroundColor: Colors.border, marginLeft: 4 },
  routeAddr: { fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text, flex: 1 },
  requestFare: {
    flexDirection: 'row', justifyContent: 'space-between', backgroundColor: Colors.background,
    borderRadius: 14, padding: 14,
  },
  requestFareLabel: {
    fontSize: 12, fontFamily: 'Inter_400Regular', color: Colors.textLight,
  },
  requestFareAmount: {
    fontSize: 22, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  requestDistance: {
    fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.text,
  },
  acceptBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, paddingVertical: 16, borderRadius: 14,
  },
  acceptBtnText: {
    fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.secondary,
  },
  waitingContent: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 16,
  },
  waitingText: {
    fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  rideStatusHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8,
  },
  statusIndicator: {
    width: 10, height: 10, borderRadius: 5,
  },
  rideAddress: {
    fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.text, marginBottom: 16,
  },
  rideInfo: {
    fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.textLight, marginBottom: 16,
  },
  actionRow: {
    flexDirection: 'row', gap: 12,
  },
  navBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.secondary, paddingVertical: 14, borderRadius: 14,
  },
  navBtnText: {
    fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.textWhite,
  },
  arrivedBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, paddingVertical: 14, borderRadius: 14,
  },
  arrivedBtnText: {
    fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.secondary,
  },
  startRideBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, paddingVertical: 16, borderRadius: 14,
  },
  startRideBtnText: {
    fontSize: 16, fontFamily: 'Inter_600SemiBold', color: Colors.secondary,
  },
  rideDestination: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16,
  },
  rideDestText: {
    fontSize: 15, fontFamily: 'Inter_500Medium', color: Colors.text, flex: 1,
  },
  completeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.success, paddingVertical: 14, borderRadius: 14,
  },
  completeBtnText: {
    fontSize: 15, fontFamily: 'Inter_600SemiBold', color: Colors.secondary,
  },
  rideEarnings: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  rideEarningsLabel: {
    fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.textLight,
  },
  rideEarningsValue: {
    fontSize: 22, fontFamily: 'Inter_700Bold', color: Colors.primary,
  },
  pickupMarker: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center',
  },
  dropoffMarker: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.accent, justifyContent: 'center', alignItems: 'center',
  },
  rideRequestMarker: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: Colors.warning, justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: Colors.textWhite,
  },
  btnPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  btnDisabled: { opacity: 0.6 },
});
