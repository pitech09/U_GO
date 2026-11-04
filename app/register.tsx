import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Platform, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import AppModal, { useAppModal } from '@/components/AppModal';
import Colors from '@/constants/colors';
import type { UserRole } from '@shared/schema';

export default function RegisterScreen() {
  const { role } = useLocalSearchParams<{ role: string }>();
  const insets = useSafeAreaInsets();
  const { register } = useAuth();
  const userRole = (role || 'rider') as UserRole;
  const isDriver = userRole === 'driver';

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [vColor, setVColor] = useState('');
  const [plate, setPlate] = useState('');
  const [seatingCapacity, setSeatingCapacity] = useState('');
  const [loading, setLoading] = useState(false);
  const { showAlert, modalProps } = useAppModal();

  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const bottomInset = Platform.OS === 'web' ? 34 : insets.bottom;

  const handleRegister = async () => {
    if (!fullName.trim() || !phone.trim() || !username.trim() || !password.trim()) {
      showAlert('Missing Fields', 'Please fill in all required fields');
      return;
    }
    if (isDriver && (!make.trim() || !model.trim() || !year.trim() || !plate.trim() || !seatingCapacity.trim())) {
      showAlert('Missing Vehicle Info', 'Please complete all vehicle details, including passenger capacity');
      return;
    }

    const capacity = Number(seatingCapacity);
    if (isDriver && (!Number.isInteger(capacity) || capacity < 1 || capacity > 8)) {
      showAlert('Invalid Passenger Capacity', 'Enter a whole number from 1 to 8, excluding the driver');
      return;
    }

    setLoading(true);
    try {
      const data: any = {
        username: username.trim(),
        password: password.trim(),
        fullName: fullName.trim(),
        phone: phone.trim(),
        role: userRole,
      };
      if (isDriver) {
        data.vehicleInfo = {
          make: make.trim(),
          model: model.trim(),
          year: year.trim(),
          color: vColor.trim() || 'N/A',
          plate: plate.trim(),
          seatingCapacity: capacity,
        };
      }
      const user = await register(data);
      if (user.role === 'rider') router.replace('/rider');
      else if (user.role === 'driver') router.replace('/driver');
    } catch (e: any) {
      showAlert('Registration Failed', e.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: topInset }]}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="arrow-back" size={24} color={Colors.textWhite} />
      </Pressable>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>{isDriver ? 'Start Driving' : 'Create Account'}</Text>
          <Text style={styles.subtitle}>
            {isDriver ? 'Register to start earning' : 'Sign up for a rider account'}
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.sectionLabel}>Personal Info</Text>
          <InputField icon="person-outline" placeholder="Full Name" value={fullName} onChangeText={setFullName} />
          <InputField icon="call-outline" placeholder="Phone Number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <InputField icon="at-outline" placeholder="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
          <InputField icon="lock-closed-outline" placeholder="Password" value={password} onChangeText={setPassword} secure />

          {isDriver && (
            <>
              <Text style={[styles.sectionLabel, { marginTop: 20 }]}>Vehicle Details</Text>
              <InputField icon="car-outline" placeholder="Make (e.g. Toyota)" value={make} onChangeText={setMake} />
              <InputField icon="speedometer-outline" placeholder="Model (e.g. Camry)" value={model} onChangeText={setModel} />
              <InputField icon="calendar-outline" placeholder="Year" value={year} onChangeText={setYear} keyboardType="number-pad" />
              <InputField icon="color-palette-outline" placeholder="Color" value={vColor} onChangeText={setVColor} />
              <InputField icon="document-text-outline" placeholder="License Plate" value={plate} onChangeText={setPlate} autoCapitalize="characters" />
              <InputField
                icon="people-outline"
                placeholder="Passenger Seats (excluding driver, 1-8)"
                value={seatingCapacity}
                onChangeText={setSeatingCapacity}
                keyboardType="number-pad"
              />
            </>
          )}

          <Pressable
            style={({ pressed }) => [styles.registerBtn, pressed && styles.btnPressed, loading && styles.btnDisabled]}
            onPress={handleRegister}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color={Colors.secondary} size="small" />
            ) : (
              <Text style={styles.registerBtnText}>Create Account</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
      <AppModal {...modalProps} />
    </View>
  );
}

function InputField({
  icon, placeholder, value, onChangeText, secure, keyboardType, autoCapitalize
}: {
  icon: string; placeholder: string; value: string; onChangeText: (t: string) => void;
  secure?: boolean; keyboardType?: any; autoCapitalize?: any;
}) {
  return (
    <View style={ifStyles.group}>
      <Ionicons name={icon as any} size={18} color={Colors.textLight} style={ifStyles.icon} />
      <TextInput
        style={ifStyles.input}
        placeholder={placeholder}
        placeholderTextColor={Colors.textLight}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
      />
    </View>
  );
}

const ifStyles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 16,
    height: 50,
  },
  icon: { marginRight: 12 },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    color: Colors.textWhite,
    height: '100%',
  },
});

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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 28,
    paddingTop: 12,
  },
  header: {
    marginBottom: 28,
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
  },
  form: {
    gap: 12,
  },
  sectionLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 2,
  },
  registerBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  registerBtnText: {
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
});
