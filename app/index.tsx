import React, { useEffect, useState, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Dimensions, Platform } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import Colors from '@/constants/colors';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';

const { width } = Dimensions.get('window');

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  const { user, isLoading } = useAuth();
  const [adminTapCount, setAdminTapCount] = useState(0);
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (!isLoading && user && !hasRedirected.current) {
      hasRedirected.current = true;
      if (user.role === 'admin') router.replace('/admin');
      else if (user.role === 'driver') router.replace('/driver');
      else if (user.role === 'rider') router.replace('/rider');
    }
  }, [user, isLoading]);

  useEffect(() => {
    if (adminTapCount >= 5) {
      setAdminTapCount(0);
      router.push('/login?role=admin');
    }
  }, [adminTapCount]);

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: Colors.secondary }]}>
        <Ionicons name="car-sport" size={48} color={Colors.primary} />
      </View>
    );
  }

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  return (
    <LinearGradient
      colors={['#101D32', '#172A45', '#101D32']}
      style={styles.container}
    >
      <Pressable
        style={[styles.versionTap, { top: topInset + 8 }]}
        onPress={() => setAdminTapCount(p => p + 1)}
      >
        <Text style={styles.versionText}>v1.0</Text>
      </Pressable>

      <View style={[styles.content, { paddingTop: topInset + 60 }]}>
        <Animated.View entering={FadeInUp.delay(200).duration(600)} style={styles.logoSection}>
          <View style={styles.logoCircle}>
            <Ionicons name="car-sport" size={44} color={Colors.textWhite} />
          </View>
          <Text style={styles.appName}>U-GO LESOTHO</Text>
          <Text style={styles.tagline}>Your ride. Your journey.</Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(400).duration(600)} style={styles.featureList}>
          <FeatureItem icon="location" text="Real-time GPS tracking" />
          <FeatureItem icon="cash" text="Transparent driver earnings" />
          <FeatureItem icon="shield-checkmark" text="Safe & reliable rides" />
        </Animated.View>
      </View>

      <Animated.View
        entering={FadeInDown.delay(600).duration(600)}
        style={[styles.bottomSection, { paddingBottom: bottomInset + 16 }]}
      >
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed]}
          onPress={() => router.push('/login?role=rider')}
        >
          <Ionicons name="person" size={20} color={Colors.secondary} />
          <Text style={styles.primaryBtnText}>Ride with us</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.btnPressed]}
          onPress={() => router.push('/login?role=driver')}
        >
          <Ionicons name="car" size={20} color={Colors.primary} />
          <Text style={styles.secondaryBtnText}>Drive & earn</Text>
        </Pressable>
      </Animated.View>
    </LinearGradient>
  );
}

function FeatureItem({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={styles.featureRow}>
      <View style={styles.featureIcon}>
        <Ionicons name={icon as any} size={20} color={Colors.primary} />
      </View>
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  versionTap: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  versionText: {
    color: 'rgba(255,255,255,0.2)',
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  content: {
    flex: 1,
    width: '100%',
    paddingHorizontal: 32,
    justifyContent: 'center',
  },
  logoSection: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logoCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  appName: {
    fontSize: 36,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
    letterSpacing: -1,
  },
  tagline: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
    marginTop: 6,
  },
  featureList: {
    gap: 16,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(54, 214, 197, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  featureText: {
    fontSize: 15,
    fontFamily: 'Inter_500Medium',
    color: 'rgba(255,255,255,0.8)',
  },
  bottomSection: {
    width: '100%',
    paddingHorizontal: 24,
    gap: 12,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
  },
  primaryBtnText: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.secondary,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(54, 214, 197, 0.1)',
    paddingVertical: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(54, 214, 197, 0.3)',
  },
  secondaryBtnText: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.primary,
  },
  btnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
});
