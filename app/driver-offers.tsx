import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform,
  ActivityIndicator, Dimensions, ScrollView, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest, authenticatedFetch, getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';
import * as Haptics from 'expo-haptics';
import type { Ride } from '@shared/schema';
import { useAppModal } from '@/components/AppModal';
import DriverTabBar from '@/components/DriverTabBar';

const { width } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  backBtn: {
    padding: 8,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text,
    textAlign: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(54, 214, 197, 0.12)',
    marginBottom: 14,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text,
    textAlign: 'center',
  },
  emptyText: {
    marginTop: 6,
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.textLight,
    textAlign: 'center',
    lineHeight: 20,
  },
  refreshBtn: {
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Colors.primary,
  },
  refreshBtnText: {
    color: Colors.secondary,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
  },
  skeletonCard: {
    height: 178,
    borderRadius: 16,
    marginBottom: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  loadingPanel: {
    alignItems: 'center',
    paddingVertical: 18,
    gap: 8,
  },
  loadingTitle: {
    color: Colors.text,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 16,
  },
  loadingSubtext: {
    color: Colors.textLight,
    fontSize: 13,
  },
  listContainer: {
    padding: 12,
  },
  offerCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  scheduledOfferCard: {
    borderColor: Colors.primary,
    borderWidth: 2,
  },
  scheduledLabel: {
    color: Colors.primary,
    fontSize: 12,
    fontFamily: 'Inter_700Bold',
    marginBottom: 10,
  },
  offerRoute: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  routePoint: {
    flex: 1,
    alignItems: 'center',
  },
  greenDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.success,
    marginBottom: 4,
  },
  orangeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.warning,
    marginBottom: 4,
  },
  routeLine: {
    width: 2,
    height: '100%',
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  routeAddr: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    color: Colors.text,
    textAlign: 'center',
  },
  offerFare: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  offerFareLabel: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
  offerFareAmount: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.primary,
  },
  offerDistance: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.textLight,
  },
  offerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  acceptBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingVertical: 12,
    borderRadius: 12,
  },
  rejectBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(229, 57, 53, 0.1)',
    paddingVertical: 12,
    borderRadius: 12,
  },
  btnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.textWhite,
  },
  rejectBtnText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: '#E53935',
  },
  btnPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    fontFamily: 'Inter_500Medium',
    color: Colors.textLight,
  },
  tabWrap: {
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  offerDetails: { color: Colors.textLight, fontSize: 12, marginTop: 8, lineHeight: 17 },
});

export default function DriverOffersScreen() {
  const insets = useSafeAreaInsets();
  const { user, isLoading: authLoading } = useAuth();
  const { showAlert } = useAppModal();
  const [offers, setOffers] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionRideId, setActionRideId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const goBackToDriverHome = () => router.replace('/driver');

  useEffect(() => {
    if (authLoading) return;
    if (!user?.id) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    fetchOffers(true);
    const interval = setInterval(fetchOffers, 5000);
    return () => clearInterval(interval);
  }, [authLoading, user?.id]);

  const fetchOffers = async (initial = false) => {
    if (!user?.id) return;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setLoadError(false);
    try {
      const baseUrl = getApiUrl();
      const [offersResult, scheduledResult] = await Promise.allSettled([
        authenticatedFetch(new URL(`/api/rides/driver/${user.id}/offers`, baseUrl).toString(), { cache: 'no-store' }),
        authenticatedFetch(new URL(`/api/rides/driver/${user.id}/scheduled`, baseUrl).toString(), { cache: 'no-store' }),
      ]);
      const immediate = offersResult.status === 'fulfilled' && offersResult.value.ok
        ? await offersResult.value.json()
        : [];
      const scheduled = scheduledResult.status === 'fulfilled' && scheduledResult.value.ok
        ? await scheduledResult.value.json()
        : [];
      const scheduledRequests = (Array.isArray(scheduled) ? scheduled : [])
        .filter((ride: Ride) => ride.status === 'scheduled' && !ride.driverId);
      const offersFailed = offersResult.status === 'rejected' || (offersResult.status === 'fulfilled' && !offersResult.value.ok);
      const scheduledFailed = scheduledResult.status === 'rejected' || (scheduledResult.status === 'fulfilled' && !scheduledResult.value.ok);
      if (offersFailed && scheduledFailed) {
        throw new Error('Could not load requests');
      }
      setOffers([
        ...(Array.isArray(immediate) ? immediate : []),
        ...scheduledRequests,
      ].filter((ride, index, all) => all.findIndex(item => item.id === ride.id) === index));
    } catch (error) {
      console.error('Could not load driver requests:', error);
      setLoadError(true);
    }
    finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  };

  const handleOfferAccept = async (rideId: string) => {
    if (!user?.id) return;
    setActionRideId(rideId);
    try {
      const res = await apiRequest('PUT', `/api/rides/${rideId}/accept`, { driverId: user.id });
      if (res.ok) {
        const ride = await res.json() as Ride;
        if (!ride.scheduledAt || new Date(ride.scheduledAt).getTime() <= Date.now()) {
          await apiRequest('PUT', `/api/rides/${rideId}/status`, { status: 'arriving' });
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/driver');
      } else {
        const body = await res.json().catch(() => ({ message: 'Could not accept offer' }));
        showAlert('Offer Error', body.message || 'Could not accept offer');
      }
    } catch (e: any) {
      showAlert('Error', e.message || 'Could not accept offer');
    } finally {
      setActionRideId(null);
    }
  };

  const handleOfferReject = async (rideId: string) => {
    if (!user?.id) return;
    try {
      const res = await apiRequest('PUT', `/api/rides/${rideId}/reject`, { driverId: user.id });
      if (res.ok) {
        setOffers(prev => prev.filter(r => r.id !== rideId));
        showAlert('Offer Rejected', 'Offer rejected');
      } else {
        const body = await res.json().catch(() => ({ message: 'Offer is no longer available' }));
        showAlert('Rejected', body.message || 'Offer is no longer available');
      }
    } catch (e: any) {
      showAlert('Error', e.message || 'Could not reject offer');
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: topInset }]}>
        <View style={styles.header}>
          <Pressable style={styles.backBtn} onPress={goBackToDriverHome} accessibilityLabel="Back to driver home">
            <Ionicons name="chevron-back-outline" size={24} color={Colors.textLight} />
          </Pressable>
          <Text style={styles.title}>New Requests</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.tabWrap}><DriverTabBar active="requests" /></View>
        <ScrollView contentContainerStyle={styles.listContainer}>
          <View style={styles.loadingPanel}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.loadingTitle}>Checking for ride requests</Text>
            <Text style={styles.loadingSubtext}>Normal and scheduled requests will appear here.</Text>
          </View>
          <View style={styles.skeletonCard} />
          <View style={styles.skeletonCard} />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topInset }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={goBackToDriverHome} accessibilityLabel="Back to driver home">
          <Ionicons name="chevron-back-outline" size={24} color={Colors.textLight} />
        </Pressable>
        <Text style={styles.title}>New Requests</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.tabWrap}>
        <DriverTabBar active="requests" />
      </View>

      {offers.length === 0 ? (
        <View style={styles.emptyContainer}>
          <View style={styles.emptyIcon}>
            <Ionicons name={loadError ? 'cloud-offline-outline' : 'notifications-outline'} size={30} color={Colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>{loadError ? 'Requests unavailable' : 'You’re all caught up'}</Text>
          <Text style={styles.emptyText}>{loadError ? 'We could not refresh requests. Check your connection and try again.' : 'New ride and scheduled requests will appear here when you are online.'}</Text>
          <Pressable style={styles.refreshBtn} onPress={() => fetchOffers(true)}>
            <Text style={styles.refreshBtnText}>Refresh requests</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchOffers(false)} tintColor={Colors.primary} />}
        >
          {offers.slice(0, 5).map(ride => (
            <View key={ride.id} style={[styles.offerCard, ride.scheduledAt && styles.scheduledOfferCard]}>
              {ride.scheduledAt && <Text style={styles.scheduledLabel}>Scheduled ride request</Text>}
              <View style={styles.offerRoute}>
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
              {ride.fare && (
                <View style={styles.offerFare}>
                  <View>
                    <Text style={styles.offerFareLabel}>Your earnings</Text>
                    <Text style={styles.offerFareAmount}>M{ride.fare.driverEarnings.toFixed(2)}</Text>
                  </View>
                  <View>
                    <Text style={styles.offerFareLabel}>Distance</Text>
                    <Text style={styles.offerDistance}>{ride.distance} KM</Text>
                  </View>
                </View>
              )}
              <Text style={styles.offerDetails}>
                {ride.serviceType === 'parcel' ? `Parcel delivery · ${ride.parcel?.weightKg} kg · ${ride.fare?.parcelMultiplier || 1} seat unit(s)` : `${ride.rideType === 'shared' ? 'Shared ride' : 'Private ride'} · ${ride.passengerCount || 1} passenger(s)`}
                {ride.scheduledAt ? ` · Scheduled ${new Date(ride.scheduledAt).toLocaleString()}` : ''}
              </Text>
              <View style={styles.offerActions}>
                <Pressable
                  style={({ pressed }) => [styles.acceptBtn, pressed && styles.btnPressed]}
                  onPress={() => handleOfferAccept(ride.id)}
                  disabled={actionRideId !== null}
                >
                  {actionRideId === ride.id ? <ActivityIndicator size="small" color={Colors.secondary} /> : <Ionicons name="checkmark" size={20} color={Colors.secondary} />}
                  <Text style={styles.btnText}>{actionRideId === ride.id ? 'Saving...' : ride.scheduledAt ? 'Reserve Scheduled Ride' : 'Accept Offer'}</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.rejectBtn, pressed && styles.btnPressed]}
                  onPress={() => handleOfferReject(ride.id)}
                  disabled={actionRideId !== null}
                >
                  <Ionicons name="close" size={20} color={Colors.textLight} />
                  <Text style={styles.rejectBtnText}>Reject</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
