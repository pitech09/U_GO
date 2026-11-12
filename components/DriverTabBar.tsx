import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Colors from '@/constants/colors';

type DriverTab = 'home' | 'requests' | 'active';

const tabs: Array<{
  key: DriverTab;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: '/driver' | '/driver-offers' | '/driver-active';
}> = [
  { key: 'home', label: 'Home', icon: 'map-outline', route: '/driver' },
  { key: 'requests', label: 'New Requests', icon: 'notifications-outline', route: '/driver-offers' },
  { key: 'active', label: 'Active Trips', icon: 'car-outline', route: '/driver-active' },
];

export default function DriverTabBar({ active }: { active: DriverTab }) {
  return (
    <View style={styles.bar}>
      {tabs.map(tab => {
        const selected = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={[styles.tab, selected && styles.selectedTab]}
            onPress={() => router.replace(tab.route)}
          >
            <Ionicons
              name={tab.icon}
              size={18}
              color={selected ? Colors.secondary : Colors.textLight}
            />
            <Text style={[styles.label, selected && styles.selectedLabel]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    gap: 6,
    padding: 6,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  tab: {
    flex: 1,
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 8,
    borderRadius: 11,
  },
  selectedTab: {
    backgroundColor: Colors.primary,
  },
  label: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.textLight,
  },
  selectedLabel: {
    color: Colors.secondary,
  },
});
