import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform,
  ActivityIndicator, Dimensions,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest, getApiUrl } from '@/lib/query-client';
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
  emptyText: {
    marginTop: 12,
    fontSize: 16,
    fontFamily: 'Inter_500Medium',
    color: Colors.textLight,
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
});

export default function DriverOffersScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { showAlert } = useAppModal();
  const [offers, setOffers] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(false);

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const goBackToDriverHome = () => router.replace('/driver');

  useEffect(() => {
    fetchOffers();
    const interval = setInterval(fetchOffers, 5000);
    return () => clearInterval(interval);
  }, [user?.id]);

  const fetchOffers = async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const baseUrl = getApiUrl();
      const url = new URL(`/api/rides/driver/${user.id}/offers`, baseUrl);
      const res = await fetch(url.toString(), { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load ride requests');
      const data = await res.json();
      const rides = Array.isArray(data) ? data : [];
      setOffers(rides);
    } catch {}
    finally {
      setLoading(false);
    }
  };

  const handleOfferAccept = async (rideId: string) => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const res = await apiRequest('PUT', `/api/rides/${rideId}/accept`, { driverId: user.id });
      if (res.ok) {
        const ride = await res.json() as Ride;
        await apiRequest('PUT', `/api/rides/${rideId}/status`, { status: 'arriving' });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace('/driver');
      } else {
        const body = await res.json().catch(() => ({ message: 'Could not accept offer' }));
        showAlert('Offer Error', body.message || 'Could not accept offer');
      }
    } catch (e: any) {
      showAlert('Error', e.message || 'Could not accept offer');
    } finally {
      setLoading(false);
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
          <Text style={styles.title}>Available Offers</Text>
          <View style={styles.backBtn} />
        </View>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading offers...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topInset }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={goBackToDriverHome} accessibilityLabel="Back to driver home">
          <Ionicons name="chevron-back-outline" size={24} color={Colors.textLight} />
        </Pressable>
        <Text style={styles.title}>Available Offers</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.tabWrap}>
        <DriverTabBar active="requests" />
      </View>

      {offers.length === 0 ? (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="small" color={Colors.primary} />
          <Text style={styles.emptyText}>No incoming offers</Text>
        </View>
      ) : (
        <View style={styles.listContainer}>
          {offers.slice(0, 5).map(ride => (
            <View key={ride.id} style={styles.offerCard}>
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
              <View style={styles.offerActions}>
                <Pressable
                  style={({ pressed }) => [styles.acceptBtn, pressed && styles.btnPressed]}
                  onPress={() => handleOfferAccept(ride.id)}
                >
                  <Ionicons name="checkmark" size={20} color={Colors.secondary} />
                  <Text style={styles.btnText}>Accept Offer</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.rejectBtn, pressed && styles.btnPressed]}
                  onPress={() => handleOfferReject(ride.id)}
                >
                  <Ionicons name="close" size={20} color={Colors.textLight} />
                  <Text style={styles.rejectBtnText}>Reject</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
