import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View, Pressable, Linking } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest, authenticatedFetch, getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';
import type { Ride } from '@shared/schema';
import DriverTabBar from '@/components/DriverTabBar';

type PickupMonitor = {
  travelSeconds?: number;
  calculatedAt?: string;
  error?: boolean;
};

function monitorStatus(slackSeconds: number): { label: string; color: string } {
  if (slackSeconds > 15 * 60) return { label: 'ON TRACK', color: Colors.success };
  if (slackSeconds > 5 * 60) return { label: 'PREPARE', color: Colors.warning };
  if (slackSeconds >= 0) return { label: 'PICKUP APPROACHING', color: Colors.warning };
  return { label: 'AT RISK OF BEING LATE', color: Colors.error };
}

export default function DriverScheduledScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [monitors, setMonitors] = useState<Record<string, PickupMonitor>>({});

  const fetchScheduled = useCallback(async () => {
    if (!user?.id) return;
    try {
      const response = await authenticatedFetch(new URL(`/api/rides/driver/${user.id}`, getApiUrl()).toString(), { cache: 'no-store' });
      if (response.ok) {
        const allRides = await response.json() as Ride[];
        setRides(allRides.filter(ride =>
          ride.driverId === user.id &&
          Boolean(ride.scheduledAt) &&
          !['cancelled', 'no_drivers_available'].includes(ride.status)
        ));
        setNow(Date.now());
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  const refreshEtas = useCallback(async () => {
    if (!user?.id || rides.length === 0) return;
    const driver = await authenticatedFetch(new URL('/api/user/' + user.id, getApiUrl()).toString(), { cache: 'no-store' }).catch(() => null);
    const driverData = driver?.ok ? await driver.json() : null;
    const location = driverData?.currentLocation;
    if (!location) {
      setMonitors(Object.fromEntries(rides.map(ride => [ride.id, { error: true }])));
      return;
    }
    const entries = await Promise.all(rides.map(async ride => {
      try {
        const response = await authenticatedFetch(new URL('/api/routes/eta', getApiUrl()).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: location, to: { lat: ride.pickup.lat, lng: ride.pickup.lng } }),
          cache: 'no-store',
        });
        if (!response.ok) return [ride.id, { error: true }] as const;
        return [ride.id, await response.json() as PickupMonitor] as const;
      } catch {
        return [ride.id, { error: true }] as const;
      }
    }));
    setMonitors(Object.fromEntries(entries));
    setNow(Date.now());
  }, [rides, user?.id]);

  useEffect(() => {
    void refreshEtas();
    const timer = setInterval(() => void refreshEtas(), 30_000);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearInterval(timer); clearInterval(clock); };
  }, [refreshEtas]);

  const releaseRide = (ride: Ride) => {
    Alert.alert(
      'Release scheduled ride?',
      'This releases your commitment and asks dispatch to find a replacement driver. The passenger booking will remain scheduled.',
      [
        { text: 'Keep ride', style: 'cancel' },
        { text: 'Release ride', style: 'destructive', onPress: async () => {
          try {
            await apiRequest('PUT', '/api/rides/' + ride.id + '/release-scheduled', { driverId: user?.id });
            await fetchScheduled();
          } catch (error: any) {
            Alert.alert('Could not release ride', error?.message || 'Please try again.');
          }
        } },
      ],
    );
  };

  const openPickupNavigation = (ride: Ride) => {
    Linking.openURL('https://www.google.com/maps/dir/?api=1&destination=' + ride.pickup.lat + ',' + ride.pickup.lng + '&travelmode=driving');
  };

  useEffect(() => {
    fetchScheduled();
    const timer = setInterval(fetchScheduled, 8000);
    return () => clearInterval(timer);
  }, [fetchScheduled]);

  return <View style={[styles.container, { paddingTop: insets.top + 10 }]}>
    <View style={styles.header}>
      <Pressable onPress={() => router.replace('/driver')} style={styles.back}><Ionicons name="chevron-back" size={22} color={Colors.textLight} /></Pressable>
      <Text style={styles.title}>Scheduled rides</Text>
      <Pressable onPress={fetchScheduled} style={styles.back}><Ionicons name="refresh" size={20} color={Colors.primary} /></Pressable>
    </View>
    <DriverTabBar active="scheduled" />
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchScheduled(); }} />}>
      {loading ? <ActivityIndicator color={Colors.primary} /> : rides.length === 0 ? <View style={styles.empty}><Ionicons name="calendar-outline" size={42} color={Colors.textLight} /><Text style={styles.emptyTitle}>No scheduled rides</Text><Text style={styles.emptyText}>Scheduled rides assigned to you will appear here.</Text></View> : rides.map(ride => { const pickupAt = new Date(ride.scheduledAt!).getTime(); const monitor = monitors[ride.id]; const slack = monitor?.travelSeconds === undefined ? undefined : pickupAt - now - monitor.travelSeconds * 1000; const status = slack === undefined ? null : monitorStatus(slack / 1000); return <View key={ride.id} style={styles.card}>
        <View style={styles.cardHeader}><Text style={styles.time}>{new Date(ride.scheduledAt!).toLocaleString()}</Text><Text style={styles.fare}>M{ride.fare?.driverEarnings.toFixed(2) ?? '0.00'}</Text></View>
        <Text style={styles.type}>{ride.serviceType === 'parcel' ? `Parcel · ${ride.parcel?.weightKg} kg` : `${ride.rideType === 'shared' ? 'Shared' : 'Private'} · ${ride.passengerCount || 1} passenger(s)`}</Text>
        <Text style={styles.route}>Pickup: {ride.pickup.address}</Text>
        <Text style={styles.route}>Drop-off: {ride.dropoff.address}</Text>
        <Text style={styles.route}>Coordinates: {ride.pickup.lat.toFixed(5)}, {ride.pickup.lng.toFixed(5)}</Text>
        {status && <Text style={[styles.status, { color: status.color }]}>{status.label}</Text>}
        {monitor?.error ? <Text style={styles.warning}>ETA unavailable — driver location or road routing is unavailable.</Text> : monitor?.travelSeconds !== undefined && <>
          <Text style={styles.monitor}>ETA to pickup: {Math.max(1, Math.ceil(monitor.travelSeconds / 60))} min</Text>
          <Text style={styles.monitor}>Expected arrival: {new Date(now + monitor.travelSeconds * 1000).toLocaleTimeString()}</Text>
          <Text style={styles.monitor}>Time remaining: {Math.max(0, Math.ceil((pickupAt - now) / 60000))} min · {slack! >= 0 ? Math.floor(slack! / 60000) + ' min early' : Math.ceil(Math.abs(slack!) / 60000) + ' min late'}</Text>
        </>}
        <View style={styles.actions}>
          <Pressable style={styles.actionButton} onPress={() => openPickupNavigation(ride)}><Ionicons name="navigate-outline" size={17} color={Colors.secondary} /><Text style={styles.actionText}>Navigate</Text></Pressable>
          {!['completed', 'arrived', 'in_progress'].includes(ride.status) && <Pressable style={styles.releaseButton} onPress={() => releaseRide(ride)}><Text style={styles.releaseText}>Release commitment</Text></Pressable>}
        </View>
      </View>; })}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, paddingHorizontal: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  back: { padding: 8 }, title: { color: Colors.text, fontFamily: 'Inter_700Bold', fontSize: 19 },
  content: { paddingVertical: 16, gap: 12 },
  card: { backgroundColor: Colors.surface, borderRadius: 15, padding: 15, borderWidth: 1, borderColor: Colors.border, gap: 7 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  time: { color: Colors.primary, fontFamily: 'Inter_700Bold', fontSize: 13, flex: 1 },
  fare: { color: Colors.text, fontFamily: 'Inter_700Bold', fontSize: 14 },
  type: { color: Colors.textLight, fontSize: 12 }, route: { color: Colors.text, fontSize: 13 },
  status: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  monitor: { color: Colors.text, fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  warning: { color: Colors.warning, fontSize: 12, lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  actionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: Colors.primary, borderRadius: 9, paddingVertical: 10 },
  actionText: { color: Colors.secondary, fontFamily: 'Inter_700Bold', fontSize: 12 },
  releaseButton: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.error, borderRadius: 9, paddingVertical: 10 },
  releaseText: { color: Colors.error, fontFamily: 'Inter_700Bold', fontSize: 12, textAlign: 'center' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 }, emptyTitle: { color: Colors.text, fontFamily: 'Inter_700Bold', fontSize: 17 }, emptyText: { color: Colors.textLight, textAlign: 'center' },
});
