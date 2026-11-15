import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { authenticatedFetch, getApiUrl } from '@/lib/query-client';
import Colors from '@/constants/colors';
import type { Ride } from '@shared/schema';
import DriverTabBar from '@/components/DriverTabBar';

export default function DriverHistoryScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [rides, setRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchHistory = useCallback(async () => {
    if (!user?.id) return;
    try {
      const response = await authenticatedFetch(
        new URL(`/api/rides/driver/${user.id}`, getApiUrl()).toString(),
        { cache: 'no-store' },
      );
      if (response.ok) {
        const allRides = await response.json() as Ride[];
        setRides(allRides.filter(ride => ride.status === 'completed'));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  const totalEarnings = rides.reduce((sum, ride) => sum + (ride.fare?.driverEarnings || 0), 0);
  const reviewed = rides.filter(ride => ride.review);
  const averageRating = reviewed.length
    ? reviewed.reduce((sum, ride) => sum + (ride.review?.rating || 0), 0) / reviewed.length
    : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 10 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => fetchHistory()} style={styles.iconButton}>
          <Ionicons name="refresh" size={20} color={Colors.primary} />
        </Pressable>
        <Text style={styles.title}>Ride History</Text>
        <View style={styles.iconButton} />
      </View>
      <DriverTabBar active="history" />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void fetchHistory(); }} />}
      >
        <View style={styles.summary}>
          <View><Text style={styles.summaryValue}>{rides.length}</Text><Text style={styles.summaryLabel}>Completed rides</Text></View>
          <View><Text style={styles.summaryValue}>M{totalEarnings.toFixed(2)}</Text><Text style={styles.summaryLabel}>Total earnings</Text></View>
          <View><Text style={styles.summaryValue}>{averageRating === null ? '—' : averageRating.toFixed(1)}</Text><Text style={styles.summaryLabel}>Rating</Text></View>
        </View>

        {loading ? <ActivityIndicator color={Colors.primary} /> : rides.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="time-outline" size={42} color={Colors.textLight} />
            <Text style={styles.emptyTitle}>No completed rides</Text>
            <Text style={styles.emptyText}>Completed rides and passenger reviews will appear here.</Text>
          </View>
        ) : rides.map(ride => (
          <View key={ride.id} style={styles.card}>
            <View style={styles.cardTop}>
              <View style={styles.statusIcon}><Ionicons name="checkmark-circle" size={22} color={Colors.success} /></View>
              <View style={styles.details}>
                <Text style={styles.route} numberOfLines={1}>{ride.pickup.address} → {ride.dropoff.address}</Text>
                <Text style={styles.date}>{new Date(ride.completedAt || ride.createdAt).toLocaleString()}</Text>
              </View>
              <Text style={styles.earning}>M{ride.fare?.driverEarnings.toFixed(2) || '0.00'}</Text>
            </View>
            {ride.review && <View style={styles.review}>
              <Text style={styles.rating}>{'★'.repeat(ride.review.rating)}{'☆'.repeat(5 - ride.review.rating)} · {ride.review.rating}/5</Text>
              {ride.review.comment && <Text style={styles.comment}>{ride.review.comment}</Text>}
            </View>}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, paddingHorizontal: 14 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: Colors.text, fontFamily: 'Inter_700Bold', fontSize: 19 },
  iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  content: { paddingVertical: 16, gap: 12 },
  summary: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: Colors.surface, borderRadius: 15, padding: 15, borderWidth: 1, borderColor: Colors.border },
  summaryValue: { color: Colors.text, fontFamily: 'Inter_700Bold', fontSize: 17 },
  summaryLabel: { color: Colors.textLight, fontSize: 11, marginTop: 3 },
  card: { backgroundColor: Colors.surface, borderRadius: 15, padding: 14, borderWidth: 1, borderColor: Colors.border, gap: 9 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusIcon: { width: 26 },
  details: { flex: 1 },
  route: { color: Colors.text, fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  date: { color: Colors.textLight, fontSize: 11, marginTop: 4 },
  earning: { color: Colors.primary, fontFamily: 'Inter_700Bold', fontSize: 14 },
  review: { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  rating: { color: Colors.primary, fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  comment: { color: Colors.textLight, fontSize: 12, lineHeight: 17, marginTop: 4 },
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyTitle: { color: Colors.text, fontFamily: 'Inter_700Bold', fontSize: 17 },
  emptyText: { color: Colors.textLight, textAlign: 'center' },
});
