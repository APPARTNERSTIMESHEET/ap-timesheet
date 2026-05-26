import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, Alert, StatusBar, Image, TextInput, ScrollView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { useAppStore } from '../store/appStore';
import { IntruderService } from '../services/IntruderService';

export default function SecurityScreen() {
  const { intruderRecords, settings, updateSettings, clearIntruderRecords, addIntruderRecord } = useAppStore();
  const [permission, requestPermission] = useCameraPermissions();
  const [showCamera, setShowCamera] = useState(false);
  const [testAttempts, setTestAttempts] = useState(0);
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState(settings.passcode || '');
  const cameraRef = useRef<CameraView>(null);

  useEffect(() => {
    if (cameraRef.current) {
      IntruderService.setCameraRef(cameraRef.current);
    }
  }, [showCamera]);

  const requestCameraPermission = async () => {
    if (!permission?.granted) {
      await requestPermission();
    }
  };

  const testIntruderCapture = async () => {
    if (!permission?.granted) {
      await requestCameraPermission();
      return;
    }

    setTestAttempts(prev => prev + 1);
    setShowCamera(true);

    // Simulate failed attempt
    setTimeout(async () => {
      const record = await IntruderService.captureIntruderPhoto(1); // 1 attempt threshold for testing
      if (record) {
        await addIntruderRecord(record);
        setShowCamera(false);
        Alert.alert('Intruder Captured!', 'Photo li gayi aur save ho gayi!');
      } else {
        setShowCamera(false);
      }
    }, 500);
  };

  const handleClearAll = () => {
    Alert.alert(
      'Sab Records Delete',
      'Saari intruder photos delete karna chahte ho?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: clearIntruderRecords },
      ]
    );
  };

  const saveSettings = async () => {
    await updateSettings({
      passcode: passcodeInput || undefined,
    });
    setShowSettings(false);
    Alert.alert('Saved!', 'Settings save ho gayi!');
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f23" />

      {/* Hidden camera for intruder detection */}
      {showCamera && permission?.granted && (
        <View style={styles.hiddenCamera}>
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing="front"
          />
        </View>
      )}

      <View style={styles.header}>
        <Text style={styles.title}>Security</Text>
        <TouchableOpacity onPress={() => setShowSettings(true)}>
          <Ionicons name="settings-outline" size={24} color="#e0e0e0" />
        </TouchableOpacity>
      </View>

      {/* Intruder Detection Card */}
      <View style={styles.detectionCard}>
        <View style={styles.detectionHeader}>
          <Ionicons name="eye" size={24} color={settings.intruderDetectionEnabled ? '#4caf50' : '#555'} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.detectionTitle}>Intruder Detection</Text>
            <Text style={styles.detectionSub}>
              {settings.intruderDetectionEnabled ? 'Active' : 'Off'} •
              {` ${settings.intruderMaxAttempts} galat tries pe photo`}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.toggle, settings.intruderDetectionEnabled && styles.toggleOn]}
            onPress={() => updateSettings({ intruderDetectionEnabled: !settings.intruderDetectionEnabled })}
          >
            <View style={[styles.toggleThumb, settings.intruderDetectionEnabled && styles.toggleThumbOn]} />
          </TouchableOpacity>
        </View>

        {!permission?.granted && (
          <TouchableOpacity style={styles.permissionBtn} onPress={requestCameraPermission}>
            <Ionicons name="camera-outline" size={16} color="#fff" />
            <Text style={styles.permissionBtnText}>Camera Permission Do</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.testBtn} onPress={testIntruderCapture}>
          <Ionicons name="camera" size={16} color="#fff" />
          <Text style={styles.testBtnText}>Test - Photo Lo Abhi</Text>
        </TouchableOpacity>
      </View>

      {/* How it works */}
      <View style={styles.howCard}>
        <Text style={styles.howTitle}>Kaise Kaam Karta Hai?</Text>
        <Text style={styles.howStep}>1. App lock screen par galat PIN/pattern daloge</Text>
        <Text style={styles.howStep}>2. {settings.intruderMaxAttempts} baar galat hone pe front camera se photo li jayegi</Text>
        <Text style={styles.howStep}>3. Photo aapki gallery mein "AP FocusLock - Intruders" album mein save hogi</Text>
        <Text style={styles.howStep}>4. Aapko notification milega</Text>
        <Text style={styles.howNote}>
          Note: Yeh feature app ke andar lock ke liye kaam karta hai. Full system-level intruder detection ke liye Android Device Admin permissions zarurat hoti hai.
        </Text>
      </View>

      {/* Intruder Records */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>
          Intruder Records ({intruderRecords.length})
        </Text>
        {intruderRecords.length > 0 && (
          <TouchableOpacity onPress={handleClearAll}>
            <Text style={styles.clearBtn}>Sab Clear Karo</Text>
          </TouchableOpacity>
        )}
      </View>

      {intruderRecords.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="shield-checkmark-outline" size={50} color="#4caf50" />
          <Text style={styles.safeText}>Sab Safe Hai!</Text>
          <Text style={styles.safeSubText}>Koi intruder record nahi mila</Text>
        </View>
      ) : (
        <FlatList
          data={[...intruderRecords].reverse()}
          keyExtractor={r => r.id}
          numColumns={3}
          contentContainerStyle={styles.photoGrid}
          renderItem={({ item: record }) => (
            <TouchableOpacity
              style={styles.photoThumb}
              onPress={() => setSelectedPhoto(record.photoUri)}
            >
              <Image source={{ uri: record.photoUri }} style={styles.thumbImg} />
              <View style={styles.thumbOverlay}>
                <Text style={styles.thumbTime}>
                  {format(new Date(record.timestamp), 'dd/MM HH:mm')}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* Full photo viewer */}
      <Modal visible={!!selectedPhoto} transparent animationType="fade">
        <View style={styles.photoViewer}>
          <TouchableOpacity style={styles.closePhoto} onPress={() => setSelectedPhoto(null)}>
            <Ionicons name="close-circle" size={36} color="#fff" />
          </TouchableOpacity>
          {selectedPhoto && (
            <Image source={{ uri: selectedPhoto }} style={styles.fullPhoto} resizeMode="contain" />
          )}
          <Text style={styles.intruderLabel}>Intruder</Text>
        </View>
      </Modal>

      {/* Settings modal */}
      <Modal visible={showSettings} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Security Settings</Text>
              <TouchableOpacity onPress={() => setShowSettings(false)}>
                <Ionicons name="close" size={24} color="#888" />
              </TouchableOpacity>
            </View>
            <ScrollView>
              <Text style={styles.settingLabel}>Kitne attempts pe photo lo?</Text>
              <View style={styles.optionRow}>
                {[1, 2, 3, 5].map(n => (
                  <TouchableOpacity
                    key={n}
                    style={[styles.optionBtn, settings.intruderMaxAttempts === n && styles.optionBtnActive]}
                    onPress={() => updateSettings({ intruderMaxAttempts: n })}
                  >
                    <Text style={[styles.optionText, settings.intruderMaxAttempts === n && styles.optionTextActive]}>
                      {n}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.switchRow}>
                <Text style={styles.settingLabel}>Strict Focus Lock Mode</Text>
                <TouchableOpacity
                  style={[styles.toggle, settings.focusLockStrict && styles.toggleOn]}
                  onPress={() => updateSettings({ focusLockStrict: !settings.focusLockStrict })}
                >
                  <View style={[styles.toggleThumb, settings.focusLockStrict && styles.toggleThumbOn]} />
                </TouchableOpacity>
              </View>
              <Text style={styles.settingHint}>
                {settings.focusLockStrict
                  ? 'Strict mode: Focus tod ne ke liye passcode chahiye'
                  : 'Normal mode: Focus kisi bhi waqt tod sakte ho'}
              </Text>

              {settings.focusLockStrict && (
                <>
                  <Text style={styles.settingLabel}>Focus Lock Passcode (4-6 digits)</Text>
                  <TextInput
                    style={styles.input}
                    value={passcodeInput}
                    onChangeText={setPasscodeInput}
                    placeholder="Passcode set karo..."
                    placeholderTextColor="#555"
                    keyboardType="numeric"
                    maxLength={6}
                    secureTextEntry
                  />
                </>
              )}

              <TouchableOpacity style={styles.saveBtn} onPress={saveSettings}>
                <Text style={styles.saveBtnText}>Save Karo</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f23' },
  hiddenCamera: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  camera: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  detectionCard: { marginHorizontal: 16, backgroundColor: '#1a1a35', borderRadius: 16, padding: 16, marginBottom: 16 },
  detectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  detectionTitle: { color: '#fff', fontWeight: '700', fontSize: 16 },
  detectionSub: { color: '#888', fontSize: 12, marginTop: 2 },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#333', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: '#4caf50' },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  toggleThumbOn: { alignSelf: 'flex-end' },
  permissionBtn: { flexDirection: 'row', gap: 8, backgroundColor: '#ff5722', borderRadius: 10, padding: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  permissionBtnText: { color: '#fff', fontWeight: '600' },
  testBtn: { flexDirection: 'row', gap: 8, backgroundColor: '#f4433644', borderWidth: 1, borderColor: '#f44336', borderRadius: 10, padding: 12, alignItems: 'center', justifyContent: 'center' },
  testBtnText: { color: '#f44336', fontWeight: '600' },
  howCard: { marginHorizontal: 16, backgroundColor: '#0a1a2a', borderRadius: 14, padding: 14, marginBottom: 16, borderLeftWidth: 3, borderLeftColor: '#2196f3' },
  howTitle: { color: '#2196f3', fontWeight: '700', marginBottom: 10 },
  howStep: { color: '#aaa', fontSize: 13, marginBottom: 6, lineHeight: 20 },
  howNote: { color: '#666', fontSize: 12, marginTop: 8, fontStyle: 'italic', lineHeight: 18 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginBottom: 12 },
  sectionTitle: { color: '#fff', fontWeight: '700', fontSize: 16 },
  clearBtn: { color: '#f44336', fontSize: 13 },
  emptyCard: { alignItems: 'center', padding: 40, gap: 12 },
  safeText: { color: '#4caf50', fontSize: 20, fontWeight: 'bold' },
  safeSubText: { color: '#888' },
  photoGrid: { paddingHorizontal: 12, paddingBottom: 100 },
  photoThumb: { flex: 1, margin: 4, aspectRatio: 1, borderRadius: 10, overflow: 'hidden' },
  thumbImg: { width: '100%', height: '100%' },
  thumbOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#00000088', padding: 4 },
  thumbTime: { color: '#fff', fontSize: 10, textAlign: 'center' },
  photoViewer: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  closePhoto: { position: 'absolute', top: 50, right: 20, zIndex: 10 },
  fullPhoto: { width: '100%', height: '80%' },
  intruderLabel: { color: '#f44336', fontWeight: 'bold', fontSize: 18, marginTop: 16 },
  modalOverlay: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#1a1a35', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff' },
  settingLabel: { color: '#aaa', fontSize: 13, marginBottom: 8, marginTop: 16 },
  settingHint: { color: '#666', fontSize: 12, marginTop: 4 },
  optionRow: { flexDirection: 'row', gap: 10 },
  optionBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: '#0f0f23', borderWidth: 1, borderColor: '#333' },
  optionBtnActive: { backgroundColor: '#f4433633', borderColor: '#f44336' },
  optionText: { color: '#888', fontWeight: '600' },
  optionTextActive: { color: '#f44336' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  input: { backgroundColor: '#0f0f23', borderRadius: 10, padding: 12, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#2a2a4a' },
  saveBtn: { backgroundColor: '#f44336', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24, marginBottom: 10 },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
});
