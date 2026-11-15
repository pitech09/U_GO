import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/lib/auth-context';
import { apiRequest } from '@/lib/query-client';
import AppModal, { useAppModal } from '@/components/AppModal';
import Colors from '@/constants/colors';

type KycType = 'national_id' | 'passport' | 'drivers_license';

export default function DriverVerificationScreen() {
  const insets = useSafeAreaInsets();
  const { user, refreshUser } = useAuth();
  const { showAlert, modalProps } = useAppModal();
  const [vehiclePhotos, setVehiclePhotos] = useState<string[]>(user?.vehiclePhotos ?? []);
  const [idDocument, setIdDocument] = useState<string | null>(null);
  const [licenseDocument, setLicenseDocument] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState<KycType>('national_id');
  const [saving, setSaving] = useState(false);

  const pickImages = async (multiple: boolean) => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: multiple,
      selectionLimit: multiple ? 5 : 1,
      quality: 0.45,
      base64: true,
    });
    if (result.canceled) return [];
    return result.assets
      .filter(asset => asset.base64)
      .map(asset => `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`);
  };

  const uploadVehiclePhotos = async () => {
    const selected = await pickImages(true);
    if (!selected.length) return;
    const next = selected.slice(0, 5);
    if (next.some(photo => photo.length > 4_000_000)) {
      showAlert('Images too large', 'Please choose smaller vehicle photos.');
      return;
    }
    setSaving(true);
    try {
      const response = await apiRequest('PUT', '/api/drivers/me/vehicle-photos', { photos: next });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Could not save vehicle photos.');
      setVehiclePhotos(payload.vehiclePhotos ?? next);
      await refreshUser();
      showAlert('Saved', 'Your vehicle photos were uploaded.');
    } catch (error: any) {
      showAlert('Upload failed', error.message || 'Could not save vehicle photos.');
    } finally {
      setSaving(false);
    }
  };

  const chooseDocument = async (kind: 'id' | 'license') => {
    const selected = await pickImages(false);
    if (selected[0]) kind === 'id' ? setIdDocument(selected[0]) : setLicenseDocument(selected[0]);
  };

  const submitKyc = async () => {
    if (!idDocument) {
      showAlert('ID document required', 'Upload your national ID, passport, or driver license.');
      return;
    }
    setSaving(true);
    try {
      const response = await apiRequest('PUT', '/api/drivers/me/kyc', {
        idDocumentType: documentType,
        idDocumentImage: idDocument,
        driverLicenseImage: licenseDocument || undefined,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message || 'Could not submit KYC.');
      await refreshUser();
      showAlert('Submitted', 'Your documents are now pending admin review.');
    } catch (error: any) {
      showAlert('KYC failed', error.message || 'Could not submit your documents.');
    } finally {
      setSaving(false);
    }
  };

  const kycStatus = user?.kyc?.status ?? 'not_submitted';
  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}><Ionicons name="arrow-back" size={22} color={Colors.textWhite} /></Pressable>
        <Text style={styles.title}>Driver verification</Text>
        <View style={{ width: 40 }} />
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
        <Text style={styles.heading}>Vehicle photos</Text>
        <Text style={styles.help}>Add clear photos showing the front, side, rear, and plate of your car.</Text>
        <View style={styles.photoGrid}>
          {vehiclePhotos.map((photo, index) => <Image key={`${photo.slice(-20)}-${index}`} source={{ uri: photo }} style={styles.photo} />)}
        </View>
        <Pressable style={styles.outlineButton} onPress={uploadVehiclePhotos} disabled={saving}>
          <Ionicons name="camera-outline" size={20} color={Colors.primary} /><Text style={styles.outlineText}>Upload vehicle photos</Text>
        </Pressable>

        <View style={styles.divider} />
        <Text style={styles.heading}>Personal KYC documents</Text>
        <Text style={styles.help}>Your documents are private and visible only to U-GO administrators during verification.</Text>
        <View style={styles.typeRow}>
          {([['national_id', 'National ID'], ['passport', 'Passport'], ['drivers_license', 'Driver license']] as [KycType, string][]).map(([value, label]) => (
            <Pressable key={value} onPress={() => setDocumentType(value)} style={[styles.typeButton, documentType === value && styles.typeSelected]}><Text style={[styles.typeText, documentType === value && styles.typeSelectedText]}>{label}</Text></Pressable>
          ))}
        </View>
        <DocumentPicker label="Identity document" image={idDocument} onPress={() => chooseDocument('id')} />
        <DocumentPicker label="Driver license (optional)" image={licenseDocument} onPress={() => chooseDocument('license')} />
        <Text style={styles.status}>Status: <Text style={styles.statusValue}>{kycStatus.replace('_', ' ')}</Text></Text>
        {kycStatus === 'rejected' && <Text style={styles.rejected}>{user?.kyc?.rejectionReason || 'Please upload corrected documents.'}</Text>}
        <Pressable style={styles.primaryButton} onPress={submitKyc} disabled={saving}>
          {saving ? <ActivityIndicator color={Colors.secondary} /> : <Text style={styles.primaryText}>Submit documents for review</Text>}
        </Pressable>
      </ScrollView>
      <AppModal {...modalProps} />
    </View>
  );
}

function DocumentPicker({ label, image, onPress }: { label: string; image: string | null; onPress: () => void }) {
  return <Pressable style={styles.documentCard} onPress={onPress}>
    {image ? <Image source={{ uri: image }} style={styles.documentImage} /> : <Ionicons name="document-attach-outline" size={28} color={Colors.primary} />}
    <View style={{ flex: 1 }}><Text style={styles.documentLabel}>{label}</Text><Text style={styles.documentAction}>{image ? 'Replace document' : 'Choose image'}</Text></View>
    <Ionicons name="chevron-forward" size={20} color={Colors.textLight} />
  </Pressable>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.backgroundDark, paddingHorizontal: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 },
  backButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.surface, alignItems: 'center', justifyContent: 'center' },
  title: { color: Colors.textWhite, fontSize: 20, fontFamily: 'Inter_700Bold' },
  heading: { color: Colors.textWhite, fontSize: 18, fontFamily: 'Inter_700Bold', marginTop: 8, marginBottom: 6 },
  help: { color: Colors.textLight, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  photo: { width: 92, height: 76, borderRadius: 10, backgroundColor: Colors.surface },
  outlineButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: Colors.primary, borderRadius: 12, padding: 13 },
  outlineText: { color: Colors.primary, fontFamily: 'Inter_600SemiBold' },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: 24 },
  typeRow: { flexDirection: 'row', gap: 7, marginBottom: 12 },
  typeButton: { flex: 1, borderWidth: 1, borderColor: Colors.border, borderRadius: 9, paddingVertical: 10, alignItems: 'center' },
  typeSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeText: { color: Colors.textLight, fontSize: 11, textAlign: 'center' },
  typeSelectedText: { color: Colors.textWhite, fontFamily: 'Inter_600SemiBold' },
  documentCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: Colors.surface, borderRadius: 12, padding: 12, marginBottom: 10 },
  documentImage: { width: 56, height: 48, borderRadius: 7 },
  documentLabel: { color: Colors.textWhite, fontFamily: 'Inter_600SemiBold' },
  documentAction: { color: Colors.textLight, fontSize: 12, marginTop: 3 },
  status: { color: Colors.textLight, marginTop: 10, textTransform: 'capitalize' },
  statusValue: { color: Colors.accent, fontFamily: 'Inter_700Bold' },
  rejected: { color: Colors.error, fontSize: 12, marginTop: 7 },
  primaryButton: { backgroundColor: Colors.primary, borderRadius: 12, alignItems: 'center', padding: 15, marginTop: 18 },
  primaryText: { color: Colors.textWhite, fontFamily: 'Inter_700Bold' },
});
