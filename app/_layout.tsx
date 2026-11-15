import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AuthProvider } from "@/lib/auth-context";
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { StatusBar } from "expo-status-bar";
import { useAuth } from "@/lib/auth-context";
import { authenticatedFetch, getApiUrl } from "@/lib/query-client";
import { startIncomingRideAlert, stopIncomingRideAlert } from "@/lib/sound-notifications";
import type { Ride } from "@shared/schema";

SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const pathname = usePathname();
  const { user } = useAuth();

  useEffect(() => {
    if (user?.role !== 'driver' || pathname === '/driver') return;

    let cancelled = false;
    let seeded = false;
    const knownImmediateRideIds = new Set<string>();

    const pollDriverOffers = async () => {
      if (cancelled || !user.id) return;
      try {
        const response = await authenticatedFetch(
          new URL(`/api/rides/driver/${user.id}/offers`, getApiUrl()).toString(),
          { cache: 'no-store' },
        );
        if (!response.ok) return;
        const data = await response.json();
        const offers = (Array.isArray(data) ? data : []) as Ride[];
        // Scheduled and immediate offers share the same delivery pipeline.
        const currentIds = new Set(offers.map(ride => ride.id));

        if (seeded) {
          const hasNewRide = offers.some(ride => !knownImmediateRideIds.has(ride.id));
          if (hasNewRide) startIncomingRideAlert();
          if (currentIds.size === 0) stopIncomingRideAlert();
        }

        knownImmediateRideIds.clear();
        currentIds.forEach(id => knownImmediateRideIds.add(id));
        seeded = true;
      } catch {
        // The screen-level fetch will retry when the driver returns home.
      }
    };

    void pollDriverOffers();
    const timer = setInterval(() => void pollDriverOffers(), 4_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pathname, user?.id, user?.role]);

  return (
    <Stack screenOptions={{ headerShown: false, headerBackTitle: "Back" }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
      <Stack.Screen name="rider" />
      <Stack.Screen name="driver" />
      <Stack.Screen name="driver-offers" />
      <Stack.Screen name="driver-active" />
      <Stack.Screen name="driver-scheduled" />
      <Stack.Screen name="driver-history" />
      <Stack.Screen name="driver-verification" />
      <Stack.Screen name="admin" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <StatusBar style="light" />
              <RootLayoutNav />
            </KeyboardProvider>
          </GestureHandlerRootView>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
