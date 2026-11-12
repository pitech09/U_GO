import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest, getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';
import type { Ride } from '@shared/schema';
import DriverTabBar from '@/components/DriverTabBar';
import { router } from 'expo-router';

const statusLabels: Record<Ride['status'], string> = {
  requested: 'Requested',
  accepted: 'Accepted',
  arriving: 'Heading to pickup',
  arrived: 'Arrived at pickup',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_drivers_available: 'Unavailable',
};

export default function DriverActiveScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const topInset = insets.top;

  const fetchActiveRides = useCallback(async () => {
    if (!user?.id) return;
    try {
      const baseUrl = getApiUrl();
      const response = await fetch(
        new URL(`/api/rides/driver/${user.id}/active`, baseUrl).toString(),
        { cache: 'no-store' }
      );
      const data = await response.json();
      setRides(Array.isArray(data) ? data : []);
    } catch {
      setRides([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => {
    fetchActiveRides();
    const interval = setInterval(fetchActiveRides, 5000);
    return () => clearInterval(interval);
  }, [fetchActiveRides]);

  const refresh = () => {
    setRefreshing(true);
    fetchActiveRides();
  };

  const updateStatus = async (ride: Ride, status: 'arrived' | 'in_progress' | 'completed') => {
    try {
      const response = await apiRequest('PUT', `/api/rides/${ride.id}/status`, { status });
      if (response.ok) fetchActiveRides();
    } catch {}
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: topInset + 16 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={Colors.primary} />}
      >
        <View style={styles.header}>
          <View style={styles.headerTitleGroup}>
            <Pressable style={styles.backButton} onPress={() => router.replace('/driver')} accessibilityLabel="Back to driver home">
              <Ionicons name="chevron-back-outline" size={22} color={Colors.textLight} />
            </Pressable>
            <View>
            <Text style={styles.eyebrow}>Driver workspace</Text>
            <Text style={styles.title}>Active Trips</Text>
            </View>
          </View>
          <Pressable style={styles.iconButton} onPress={refresh}>
            <Ionicons name="refresh" size={20} color={Colors.primary} />
          </Pressable>
        </View>

        <DriverTabBar active="active" />

        {loading ? (
          <View style={styles.emptyState}>
            <ActivityIndicator size="large" color={Colors.primary} />
            <Text style={styles.emptyText}>Loading active trips...</Text>
          </View>
        ) : rides.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="car-outline" size={48} color={Colors.textLight} />
            <Text style={styles.emptyTitle}>No active trips</Text>
            <Text style={styles.emptyText}>Accepted trips will appear here.</Text>
            <Pressable style={styles.primaryButton} onPress={() => router.replace('/driver-offers')}>
              <Text style={styles.primaryButtonText}>View new requests</Text>
            </Pressable>
          </View>
        ) : (
          rides.map(ride => (
            <View key={ride.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.statusPill}>
                  <View style={styles.statusDot} />
                  <Text style={styles.statusText}>{statusLabels[ride.status]}</Text>
                </View>
                <Text style={styles.passengers}>{ride.passengerCount || 1} passenger{ride.passengerCount === 1 ? '' : 's'}</Text>
              </View>
              <RouteRow icon="location" label="Pickup" address={ride.pickup.address} />
              <RouteRow icon="flag" label="Drop-off" address={ride.dropoff.address} />
              <View style={styles.fareRow}>
                <Text style={styles.fareLabel}>Your earnings</Text>
                <Text style={styles.fareValue}>M{ride.fare?.driverEarnings.toFixed(2) ?? '0.00'}</Text>
              </View>
              {ride.status === 'arriving' && (
                <ActionButton label="I've arrived" onPress={() => updateStatus(ride, 'arrived')} />
              )}
              {ride.status === 'arrived' && (
                <ActionButton label="Start trip" onPress={() => updateStatus(ride, 'in_progress')} />
              )}
              {ride.status === 'in_progress' && (
                <ActionButton label="Complete trip" onPress={() => updateStatus(ride, 'completed')} />
              )}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function RouteRow({ icon, label, address }: { icon: 'location' | 'flag'; label: string; address: string }) {
  return (
    <View style={styles.routeRow}>
      <Ionicons name={icon} size={18} color={icon === 'location' ? Colors.success : Colors.warning} />
      <View style={styles.routeCopy}>
        <Text style={styles.routeLabel}>{label}</Text>
        <Text style={styles.routeAddress} numberOfLines={2}>{address}</Text>
      </View>
    </View>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.primaryButton} onPress={onPress}>
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitleGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backButton: { width: 40, height: 40, borderRadius: 12, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.textLight },
  title: { marginTop: 3, fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text },
  iconButton: { width: 42, height: 42, borderRadius: 13, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 80, gap: 8 },
  emptyTitle: { marginTop: 8, fontSize: 18, fontFamily: 'Inter_600SemiBold', color: Colors.text },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', color: Colors.textLight, textAlign: 'center' },
  card: { backgroundColor: Colors.surface, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: Colors.border, gap: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(54, 214, 197, 0.12)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20 },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.success },
  statusText: { fontSize: 12, fontFamily: 'Inter_600SemiBold', color: Colors.primary },
  passengers: { fontSize: 12, fontFamily: 'Inter_500Medium', color: Colors.textLight },
  routeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  routeCopy: { flex: 1 },
  routeLabel: { fontSize: 11, fontFamily: 'Inter_500Medium', color: Colors.textLight },
  routeAddress: { marginTop: 2, fontSize: 14, fontFamily: 'Inter_500Medium', color: Colors.text },
  fareRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 12 },
  fareLabel: { fontSize: 13, fontFamily: 'Inter_500Medium', color: Colors.textLight },
  fareValue: { fontSize: 18, fontFamily: 'Inter_700Bold', color: Colors.primary },
  primaryButton: { alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary, paddingVertical: 13, borderRadius: 12, marginTop: 4 },
  primaryButtonText: { fontSize: 14, fontFamily: 'Inter_600SemiBold', color: Colors.secondary },
});
