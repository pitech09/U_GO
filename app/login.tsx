import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import AppModal, { useAppModal } from '@/components/AppModal';
import Colors from '@/constants/colors';
import type { UserRole } from '@shared/schema';

export default function LoginScreen() {
  const { role } = useLocalSearchParams<{ role: string }>();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { showAlert, modalProps } = useAppModal();

  const userRole = (role || 'rider') as UserRole;
  const isAdmin = userRole === 'admin';

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      showAlert('Missing Fields', 'Please enter both username and password');
      return;
    }
    setLoading(true);
    try {
      const user = await login(username.trim(), password.trim());
      if (isAdmin && user.role !== 'admin') {
        showAlert('Access Denied', 'This account does not have admin access');
        return;
      }
      if (user.role === 'admin') {
        router.replace('/admin');
      } else if (user.role === 'driver') {
        if (userRole === 'rider') {
          router.replace('/rider');
        } else {
          router.replace('/driver');
        }
      } else if (user.role === 'rider') {
        if (userRole === 'driver') {
          showAlert('Not a Driver', 'This account is registered as a rider. Drivers can log in from the rider portal too.');
          return;
        }
        router.replace('/rider');
      }
    } catch (e: any) {
      showAlert('Login Failed', e.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  const roleLabel = isAdmin ? 'Admin' : userRole === 'driver' ? 'Driver' : 'Rider';
  const roleIcon = isAdmin ? 'shield' : userRole === 'driver' ? 'car' : 'person';

  return (
    <View style={[styles.container, { paddingTop: topInset }]}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="arrow-back" size={24} color={Colors.textWhite} />
      </Pressable>

      <View style={styles.content}>
        <View style={styles.header}>
          <View style={[styles.roleIcon, isAdmin && styles.adminIcon]}>
            <Ionicons name={roleIcon as any} size={28} color={isAdmin ? Colors.accent : Colors.primary} />
          </View>
          <Text style={styles.title}>{roleLabel} Login</Text>
          <Text style={styles.subtitle}>
            {isAdmin ? 'Platform administration access' : `Sign in to your ${roleLabel.toLowerCase()} account`}
          </Text>
        </View>

        <View style={styles.form}>
          <View style={styles.inputGroup}>
            <Ionicons name="person-outline" size={20} color={Colors.textLight} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Username"
              placeholderTextColor={Colors.textLight}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <Ionicons name="lock-closed-outline" size={20} color={Colors.textLight} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={Colors.textLight}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
            />
            <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
              <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={Colors.textLight} />
            </Pressable>
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.loginBtn,
              isAdmin && styles.adminBtn,
              pressed && styles.btnPressed,
              loading && styles.btnDisabled,
            ]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={Colors.secondary} size="small" />
            ) : (
              <Text style={styles.loginBtnText}>Sign In</Text>
            )}
          </Pressable>
        </View>

        {!isAdmin && (
          <View style={styles.footer}>
            <Text style={styles.footerText}>Don't have an account?</Text>
            <Pressable onPress={() => router.push(`/register?role=${userRole}`)}>
              <Text style={styles.footerLink}>Sign Up</Text>
            </Pressable>
          </View>
        )}
      </View>
      <AppModal {...modalProps} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.backgroundDark,
  },
  backBtn: {
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
    marginTop: 8,
  },
  content: {
    flex: 1,
    paddingHorizontal: 28,
    justifyContent: 'center',
    marginTop: -60,
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  roleIcon: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: 'rgba(54, 214, 197, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  adminIcon: {
    backgroundColor: 'rgba(255, 107, 53, 0.12)',
  },
  title: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    color: Colors.textWhite,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
    textAlign: 'center',
  },
  form: {
    gap: 14,
  },
  inputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 16,
    height: 54,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    color: Colors.textWhite,
    height: '100%',
  },
  eyeBtn: {
    padding: 6,
  },
  loginBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  adminBtn: {
    backgroundColor: Colors.accent,
  },
  loginBtnText: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.secondary,
  },
  btnPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  btnDisabled: {
    opacity: 0.6,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginTop: 24,
  },
  footerText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.textLight,
  },
  footerLink: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.primary,
  },
});
