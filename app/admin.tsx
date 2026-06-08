import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, Platform,
  ActivityIndicator, RefreshControl, TextInput, Switch
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { getApiUrl } from '@/lib/query-client';
import AppModal, { useAppModal } from '@/components/AppModal';
import Colors from '@/constants/colors';
import type { Ride, PlatformConfig } from '@shared/schema';

interface Stats {
  totalDrivers: number;
  totalRiders: number;
  onlineDrivers: number;
  totalRides: number;
  activeRides: number;
  completedRides: number;
  cancelledRides: number;
  suspendedUsers: number;
  totalRevenue: number;
  totalDriverEarnings: number;
  platformRevenue: number;
}

interface SafeUser {
  id: string;
  username: string;
  role: string;
  fullName: string;
  phone: string;
  isOnline?: boolean;
  suspended?: boolean;
  rating?: number;
  totalRides?: number;
  totalEarnings?: number;
}

type AdminTab = 'overview' | 'rides' | 'users' | 'settings';

export default function AdminScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { showAlert, showConfirm, modalProps } = useAppModal();
  const [tab, setTab] = useState<AdminTab>('overview');
  const [stats, setStats] = useState<Stats | null>(null);
  const [rides, setRides] = useState<Ride[]>([]);
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [config, setConfig] = useState<PlatformConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  const fetchAll = useCallback(async () => {
    try {
      const baseUrl = getApiUrl();
      const [statsRes, ridesRes, usersRes, configRes] = await Promise.all([
        fetch(new URL('/api/admin/stats', baseUrl).toString()),
        fetch(new URL('/api/admin/rides', baseUrl).toString()),
        fetch(new URL('/api/admin/users', baseUrl).toString()),
        fetch(new URL('/api/admin/config', baseUrl).toString()),
      ]);
      setStats(await statsRes.json());
      setRides(await ridesRes.json());
      setUsers(await usersRes.json());
      setConfig(await configRes.json());
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 8000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchAll();
  };

  const suspendUser = async (userId: string) => {
    setActionLoading(userId);
    try {
      const baseUrl = getApiUrl();
      const res = await fetch(new URL(`/api/admin/users/${userId}/suspend`, baseUrl).toString(), { method: 'PUT' });
      if (res.ok) {
        const updated = await res.json();
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, suspended: updated.suspended, isOnline: updated.isOnline } : u));
        fetchAll();
      }
    } catch {} finally {
      setActionLoading(null);
    }
  };

  const deleteUser = async (userId: string, name: string) => {
    const doDelete = async () => {
      setActionLoading(userId);
      try {
        const baseUrl = getApiUrl();
        const res = await fetch(new URL(`/api/admin/users/${userId}`, baseUrl).toString(), { method: 'DELETE' });
        if (res.ok) {
          setUsers(prev => prev.filter(u => u.id !== userId));
          fetchAll();
        }
      } catch {} finally {
        setActionLoading(null);
      }
    };

    showConfirm('Remove User', `Remove ${name} permanently? This cannot be undone.`, doDelete, 'Remove', true);
  };

  const cancelRide = async (rideId: string) => {
    setActionLoading(rideId);
    try {
      const baseUrl = getApiUrl();
      const res = await fetch(new URL(`/api/admin/rides/${rideId}/cancel`, baseUrl).toString(), { method: 'PUT' });
      if (res.ok) {
        setRides(prev => prev.map(r => r.id === rideId ? { ...r, status: 'cancelled' } : r));
        fetchAll();
      }
    } catch {} finally {
      setActionLoading(null);
    }
  };

  const updateConfig = async (updates: Partial<PlatformConfig>) => {
    try {
      const baseUrl = getApiUrl();
      const res = await fetch(new URL('/api/admin/config', baseUrl).toString(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        setConfig(await res.json());
      }
    } catch {}
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'requested': return Colors.warning;
      case 'accepted': case 'arriving': return '#007AFF';
      case 'arrived': case 'in_progress': return Colors.primary;
      case 'completed': return Colors.success;
      case 'cancelled': return Colors.error;
      default: return Colors.textLight;
    }
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: Colors.backgroundDark }]}>
        <ActivityIndicator size="large" color={Colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topInset }]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>Admin Panel</Text>
          <Text style={styles.headerName}>{user?.fullName || 'Admin'}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.switchBtn} onPress={() => router.replace('/rider')}>
            <Ionicons name="person" size={18} color={Colors.primary} />
          </Pressable>
          <Pressable style={styles.switchBtn} onPress={() => router.replace('/driver')}>
            <Ionicons name="car" size={18} color={Colors.primary} />
          </Pressable>
          <Pressable
            style={styles.logoutBtn}
            onPress={() => { logout(); router.replace('/'); }}
          >
            <Ionicons name="log-out-outline" size={20} color={Colors.error} />
          </Pressable>
        </View>
      </View>

      <View style={styles.tabBar}>
        {(['overview', 'rides', 'users', 'settings'] as AdminTab[]).map(t => (
          <Pressable
            key={t}
            style={[styles.tabItem, tab === t && styles.tabActive]}
            onPress={() => setTab(t)}
          >
            <Ionicons
              name={t === 'overview' ? 'stats-chart' : t === 'rides' ? 'car' : t === 'users' ? 'people' : 'settings'}
              size={16}
              color={tab === t ? Colors.textWhite : Colors.textLight}
            />
          </Pressable>
        ))}
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
      >
        {tab === 'overview' && stats && <OverviewTab stats={stats} config={config} />}
        {tab === 'rides' && (
          <RidesTab rides={rides} statusColor={statusColor} cancelRide={cancelRide} actionLoading={actionLoading} />
        )}
        {tab === 'users' && (
          <UsersTab users={users} suspendUser={suspendUser} deleteUser={deleteUser} actionLoading={actionLoading} />
        )}
        {tab === 'settings' && config && (
          <SettingsTab config={config} updateConfig={updateConfig} />
        )}
      </ScrollView>
      <AppModal {...modalProps} />
    </View>
  );
}

function OverviewTab({ stats, config }: { stats: Stats; config: PlatformConfig | null }) {
  const driverShare = config?.driverSharePercent ?? 82;
  return (
    <>
      <View style={styles.revenueCard}>
        <Text style={styles.revenueLabel}>Platform Revenue</Text>
        <Text style={styles.revenueAmount}>${stats.platformRevenue.toFixed(2)}</Text>
        <View style={styles.revenueRow}>
          <View style={styles.revenueStat}>
            <Text style={styles.revenueStatValue}>${stats.totalRevenue.toFixed(2)}</Text>
            <Text style={styles.revenueStatLabel}>Total Fares</Text>
          </View>
          <View style={styles.revDivider} />
          <View style={styles.revenueStat}>
            <Text style={styles.revenueStatValue}>${stats.totalDriverEarnings.toFixed(2)}</Text>
            <Text style={styles.revenueStatLabel}>Driver Payouts</Text>
          </View>
        </View>
      </View>

      <View style={styles.statsGrid}>
        <StatCard icon="people" label="Riders" value={stats.totalRiders.toString()} color="#007AFF" />
        <StatCard icon="car" label="Drivers" value={stats.totalDrivers.toString()} color={Colors.primary} />
        <StatCard icon="radio-button-on" label="Online" value={stats.onlineDrivers.toString()} color={Colors.success} />
        <StatCard icon="flash" label="Active" value={(stats.activeRides ?? 0).toString()} color={Colors.warning} />
        <StatCard icon="checkmark-circle" label="Done" value={(stats.completedRides ?? 0).toString()} color={Colors.success} />
        <StatCard icon="close-circle" label="Cancelled" value={(stats.cancelledRides ?? 0).toString()} color={Colors.error} />
        <StatCard icon="ban" label="Suspended" value={(stats.suspendedUsers ?? 0).toString()} color="#FF453A" />
        <StatCard icon="list" label="Total" value={(stats.totalRides ?? 0).toString()} color={Colors.textLight} />
      </View>

      <View style={styles.compSection}>
        <Text style={styles.sectionTitle}>Compensation Split</Text>
        <View style={styles.compCard}>
          <View style={styles.compRow}>
            <Text style={styles.compLabel}>Driver Share</Text>
            <Text style={styles.compValue}>{driverShare}%</Text>
          </View>
          <View style={styles.compBarBg}>
            <View style={[styles.compBarFill, { width: `${driverShare}%`, backgroundColor: Colors.primary }]} />
          </View>
          <View style={styles.compRow}>
            <Text style={styles.compLabel}>Platform Fee</Text>
            <Text style={[styles.compValue, { color: Colors.accent }]}>{100 - driverShare}%</Text>
          </View>
          <View style={styles.compBarBg}>
            <View style={[styles.compBarFill, { width: `${100 - driverShare}%`, backgroundColor: Colors.accent }]} />
          </View>
        </View>
      </View>
    </>
  );
}

function RidesTab({ rides, statusColor, cancelRide, actionLoading }: {
  rides: Ride[];
  statusColor: (s: string) => string;
  cancelRide: (id: string) => void;
  actionLoading: string | null;
}) {
  const activeRides = rides.filter(r => !['completed', 'cancelled'].includes(r.status));
  const pastRides = rides.filter(r => ['completed', 'cancelled'].includes(r.status));

  return (
    <>
      {activeRides.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Active Rides ({activeRides.length})</Text>
          {activeRides.map(ride => (
            <RideCard key={ride.id} ride={ride} statusColor={statusColor} cancelRide={cancelRide} actionLoading={actionLoading} canCancel />
          ))}
        </>
      )}

      <Text style={[styles.sectionTitle, activeRides.length > 0 && { marginTop: 16 }]}>
        All Rides ({rides.length})
      </Text>
      {rides.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="car-outline" size={36} color={Colors.textLight} />
          <Text style={styles.emptyText}>No rides yet</Text>
        </View>
      ) : (
        rides.slice(0, 50).map(ride => (
          <RideCard key={ride.id} ride={ride} statusColor={statusColor} cancelRide={cancelRide} actionLoading={actionLoading} canCancel={!['completed', 'cancelled'].includes(ride.status)} />
        ))
      )}
    </>
  );
}

function RideCard({ ride, statusColor, cancelRide, actionLoading, canCancel }: {
  ride: Ride;
  statusColor: (s: string) => string;
  cancelRide: (id: string) => void;
  actionLoading: string | null;
  canCancel: boolean;
}) {
  return (
    <View style={styles.rideCard}>
      <View style={styles.rideHeader}>
        <View style={[styles.rideStatusBadge, { backgroundColor: statusColor(ride.status) + '20' }]}>
          <View style={[styles.rideStatusDot, { backgroundColor: statusColor(ride.status) }]} />
          <Text style={[styles.rideStatusLabel, { color: statusColor(ride.status) }]}>
            {ride.status.replace('_', ' ')}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {ride.fare && <Text style={styles.rideFare}>${ride.fare.totalFare.toFixed(2)}</Text>}
          {canCancel && (
            <Pressable
              style={styles.cancelBtn}
              onPress={() => cancelRide(ride.id)}
              disabled={actionLoading === ride.id}
            >
              {actionLoading === ride.id ? (
                <ActivityIndicator size="small" color={Colors.error} />
              ) : (
                <Ionicons name="close-circle" size={20} color={Colors.error} />
              )}
            </Pressable>
          )}
        </View>
      </View>
      <View style={styles.rideRoute}>
        <View style={styles.rideRoutePoint}>
          <View style={styles.greenDot} />
          <Text style={styles.rideAddr} numberOfLines={1}>{ride.pickup.address}</Text>
        </View>
        <View style={styles.routeLine} />
        <View style={styles.rideRoutePoint}>
          <View style={styles.orangeDot} />
          <Text style={styles.rideAddr} numberOfLines={1}>{ride.dropoff.address}</Text>
        </View>
      </View>
      <View style={styles.rideMeta}>
        <Text style={styles.rideMetaText}>
          {ride.riderName || 'Unknown'} {ride.driverName ? `\u2192 ${ride.driverName}` : ''}
        </Text>
        <Text style={styles.rideMetaTime}>{new Date(ride.createdAt).toLocaleString()}</Text>
      </View>
      {ride.review && (
        <View style={styles.reviewBox}>
          <View style={styles.reviewBoxHeader}>
            <View style={styles.reviewStarsRow}>
              {[1, 2, 3, 4, 5].map((s) => (
                <Ionicons key={s} name={s <= ride.review!.rating ? 'star' : 'star-outline'} size={14} color={s <= ride.review!.rating ? '#FFB800' : Colors.border} />
              ))}
            </View>
            <Text style={styles.reviewBoxDate}>{new Date(ride.review.createdAt).toLocaleDateString()}</Text>
          </View>
          {ride.review.comment && (
            <Text style={styles.reviewBoxComment}>"{ride.review.comment}"</Text>
          )}
        </View>
      )}
    </View>
  );
}

function UsersTab({ users, suspendUser, deleteUser, actionLoading }: {
  users: SafeUser[];
  suspendUser: (id: string) => void;
  deleteUser: (id: string, name: string) => void;
  actionLoading: string | null;
}) {
  const drivers = users.filter(u => u.role === 'driver');
  const riders = users.filter(u => u.role === 'rider');

  return (
    <>
      <Text style={styles.sectionTitle}>Drivers ({drivers.length})</Text>
      {drivers.map(u => (
        <UserCard key={u.id} user={u} suspendUser={suspendUser} deleteUser={deleteUser} actionLoading={actionLoading} />
      ))}

      <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Riders ({riders.length})</Text>
      {riders.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="people-outline" size={36} color={Colors.textLight} />
          <Text style={styles.emptyText}>No riders yet</Text>
        </View>
      ) : (
        riders.map(u => (
          <UserCard key={u.id} user={u} suspendUser={suspendUser} deleteUser={deleteUser} actionLoading={actionLoading} />
        ))
      )}
    </>
  );
}

function UserCard({ user: u, suspendUser, deleteUser, actionLoading }: {
  user: SafeUser;
  suspendUser: (id: string) => void;
  deleteUser: (id: string, name: string) => void;
  actionLoading: string | null;
}) {
  const isLoading = actionLoading === u.id;
  return (
    <View style={[styles.userCard, u.suspended && styles.userCardSuspended]}>
      <View style={[styles.userAvatar, { backgroundColor: u.role === 'driver' ? 'rgba(0,217,165,0.12)' : 'rgba(0,122,255,0.12)' }]}>
        <Ionicons
          name={u.role === 'driver' ? 'car' : 'person'}
          size={20}
          color={u.suspended ? Colors.error : (u.role === 'driver' ? Colors.primary : '#007AFF')}
        />
      </View>
      <View style={styles.userInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[styles.userName, u.suspended && { color: Colors.error }]}>{u.fullName}</Text>
          {u.suspended && (
            <View style={styles.suspendedBadge}>
              <Text style={styles.suspendedText}>Suspended</Text>
            </View>
          )}
        </View>
        <View style={styles.userMeta}>
          <Text style={styles.userRole}>{u.role}</Text>
          {u.isOnline && !u.suspended && (
            <View style={styles.onlineBadge}>
              <View style={styles.onlineDotSmall} />
              <Text style={styles.onlineLabel}>Online</Text>
            </View>
          )}
          {u.role === 'driver' && (
            <Text style={styles.userRole}>
              {(u.rating || 5.0).toFixed(1)} | {u.totalRides || 0} rides
            </Text>
          )}
        </View>
      </View>
      <View style={styles.userActions}>
        {isLoading ? (
          <ActivityIndicator size="small" color={Colors.accent} />
        ) : (
          <>
            <Pressable style={styles.actionBtn} onPress={() => suspendUser(u.id)}>
              <Ionicons
                name={u.suspended ? 'play-circle' : 'pause-circle'}
                size={24}
                color={u.suspended ? Colors.primary : Colors.warning}
              />
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={() => deleteUser(u.id, u.fullName)}>
              <Ionicons name="trash" size={20} color={Colors.error} />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

function SettingsTab({ config, updateConfig }: { config: PlatformConfig; updateConfig: (u: Partial<PlatformConfig>) => void }) {
  const [baseFare, setBaseFare] = useState(config.baseFare.toString());
  const [perMile, setPerMile] = useState(config.perMile.toString());
  const [perMinute, setPerMinute] = useState(config.perMinute.toString());
  const [driverShare, setDriverShare] = useState(config.driverSharePercent.toString());
  const [minFare, setMinFare] = useState(config.minimumFare.toString());
  const [surge, setSurge] = useState(config.surgePricing);
  const [surgeMultiplier, setSurgeMultiplier] = useState(config.surgeMultiplier.toString());
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBaseFare(config.baseFare.toString());
    setPerMile(config.perMile.toString());
    setPerMinute(config.perMinute.toString());
    setDriverShare(config.driverSharePercent.toString());
    setMinFare(config.minimumFare.toString());
    setSurge(config.surgePricing);
    setSurgeMultiplier(config.surgeMultiplier.toString());
  }, [config]);

  const saveConfig = async (overrides?: Partial<PlatformConfig>) => {
    setSaving(true);
    try {
      await updateConfig({
        baseFare: parseFloat(baseFare) || 2.50,
        perMile: parseFloat(perMile) || 1.75,
        perMinute: parseFloat(perMinute) || 0.35,
        driverSharePercent: Math.min(100, Math.max(0, parseInt(driverShare) || 82)),
        minimumFare: parseFloat(minFare) || 5.00,
        surgePricing: surge,
        surgeMultiplier: parseFloat(surgeMultiplier) || 1.0,
        ...overrides,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleSurgeToggle = async (value: boolean) => {
    setSurge(value);
    const currentMultiplier = parseFloat(surgeMultiplier) || 1.0;
    if (value && currentMultiplier <= 1) {
      setSurgeMultiplier('1.5');
      await updateConfig({ surgePricing: value, surgeMultiplier: 1.5 });
    } else {
      await updateConfig({ surgePricing: value });
    }
  };

  return (
    <>
      <Text style={styles.sectionTitle}>Fare Configuration</Text>
      <View style={styles.settingsCard}>
        <ConfigRow label="Base Fare ($)" value={baseFare} onChange={setBaseFare} />
        <ConfigRow label="Per Mile ($)" value={perMile} onChange={setPerMile} />
        <ConfigRow label="Per Minute ($)" value={perMinute} onChange={setPerMinute} />
        <ConfigRow label="Driver Share (%)" value={driverShare} onChange={setDriverShare} />
        <ConfigRow label="Minimum Fare ($)" value={minFare} onChange={setMinFare} />
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Surge Pricing</Text>
      <View style={styles.settingsCard}>
        <View style={styles.configRow}>
          <Text style={styles.configLabel}>Enable Surge</Text>
          <Switch
            value={surge}
            onValueChange={handleSurgeToggle}
            trackColor={{ false: 'rgba(255,255,255,0.1)', true: 'rgba(255,107,53,0.3)' }}
            thumbColor={surge ? Colors.accent : '#ccc'}
          />
        </View>
        {surge && (
          <ConfigRow label="Surge Multiplier (x)" value={surgeMultiplier} onChange={setSurgeMultiplier} />
        )}
      </View>

      <Pressable style={[styles.saveBtn, saved && styles.saveBtnSaved, saving && { opacity: 0.6 }]} onPress={() => saveConfig()} disabled={saving}>
        <Ionicons name={saved ? 'checkmark-circle' : 'save'} size={20} color={Colors.textWhite} />
        <Text style={styles.saveBtnText}>{saved ? 'Saved' : 'Save Changes'}</Text>
      </Pressable>
    </>
  );
}

function ConfigRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.configRow}>
      <Text style={styles.configLabel}>{label}</Text>
      <TextInput
        style={styles.configInput}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        placeholderTextColor={Colors.textLight}
      />
    </View>
  );
}

function StatCard({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <View style={scStyles.card}>
      <Ionicons name={icon as any} size={22} color={color} />
      <Text style={scStyles.value}>{value}</Text>
      <Text style={scStyles.label}>{label}</Text>
    </View>
  );
}

const scStyles = StyleSheet.create({
  card: {
    width: '23%',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 12,
    alignItems: 'center',
    gap: 3,
  },
  value: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
  },
  label: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.backgroundDark,
  },
  loadingContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerLabel: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: Colors.accent,
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
  },
  headerName: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  switchBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(0,217,165,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoutBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(255,59,48,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    padding: 4,
    marginBottom: 16,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: Colors.accent,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  revenueCard: {
    backgroundColor: 'rgba(255, 107, 53, 0.08)',
    borderRadius: 20,
    padding: 24,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 53, 0.15)',
  },
  revenueLabel: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.accent,
    marginBottom: 4,
  },
  revenueAmount: {
    fontSize: 40,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
    marginBottom: 16,
  },
  revenueRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  revenueStat: { alignItems: 'center' },
  revenueStatValue: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
  },
  revenueStatLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
    marginTop: 2,
  },
  revDivider: {
    width: 1,
    height: 30,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
    marginBottom: 12,
  },
  compSection: { marginBottom: 20 },
  compCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  compRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  compLabel: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.textLight,
  },
  compValue: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: Colors.primary,
  },
  compBarBg: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  compBarFill: {
    height: 6,
    borderRadius: 3,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 8,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
  rideCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
  },
  rideHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  rideStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  rideStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  rideStatusLabel: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    textTransform: 'capitalize' as const,
  },
  rideFare: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
  },
  rideRoute: { gap: 4, marginBottom: 10 },
  rideRoutePoint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  greenDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.primary },
  orangeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.accent },
  routeLine: { width: 2, height: 10, backgroundColor: 'rgba(255,255,255,0.1)', marginLeft: 3 },
  rideAddr: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
    flex: 1,
  },
  rideMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rideMetaText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: Colors.textWhite,
  },
  rideMetaTime: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
  reviewBox: {
    backgroundColor: 'rgba(255, 184, 0, 0.08)',
    borderRadius: 10,
    padding: 10,
    marginTop: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#FFB800',
  },
  reviewBoxHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  reviewStarsRow: {
    flexDirection: 'row',
    gap: 2,
  },
  reviewBoxDate: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
  reviewBoxComment: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.textWhite,
    fontStyle: 'italic' as const,
    marginTop: 4,
  },
  cancelBtn: {
    padding: 4,
  },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 14,
    marginBottom: 8,
  },
  userCardSuspended: {
    borderWidth: 1,
    borderColor: 'rgba(255,59,48,0.25)',
    backgroundColor: 'rgba(255,59,48,0.05)',
  },
  userAvatar: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userInfo: { flex: 1 },
  userName: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.textWhite,
  },
  userMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  userRole: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
    textTransform: 'capitalize' as const,
  },
  onlineBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  onlineDotSmall: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.success,
  },
  onlineLabel: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    color: Colors.success,
  },
  suspendedBadge: {
    backgroundColor: 'rgba(255,59,48,0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  suspendedText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.error,
  },
  userActions: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  actionBtn: {
    padding: 4,
  },
  settingsCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  configRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  configLabel: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    color: Colors.textLight,
    flex: 1,
  },
  configInput: {
    width: 90,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: Colors.textWhite,
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
    textAlign: 'right' as const,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.accent,
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 20,
  },
  saveBtnSaved: {
    backgroundColor: Colors.success,
  },
  saveBtnText: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.textWhite,
  },
});
