import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../store/appStore';
import { NotificationService } from '../services/NotificationService';

export default function SettingsScreen() {
  const { settings, updateSettings } = useAppStore();
  const [passcode, setPasscode] = useState(settings.passcode || '');

  const requestNotificationPermission = async () => {
    const granted = await NotificationService.requestPermissions();
    Alert.alert(granted ? 'Permission Mili!' : 'Permission Nahi Mili', granted ? 'Notifications kaam karein ge.' : 'Settings mein jaake permission do.');
  };

  const savePasscode = async () => {
    if (passcode && (passcode.length < 4 || passcode.length > 6)) {
      Alert.alert('Error', 'Passcode 4-6 digits ka hona chahiye!');
      return;
    }
    await updateSettings({ passcode: passcode || undefined });
    Alert.alert('Saved!', passcode ? 'Passcode set ho gaya!' : 'Passcode remove ho gaya!');
  };

  const Section = ({ title }: { title: string }) => (
    <Text style={styles.sectionTitle}>{title}</Text>
  );

  const ToggleRow = ({
    label, subtext, value, onToggle
  }: { label: string; subtext?: string; value: boolean; onToggle: () => void }) => (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {subtext && <Text style={styles.rowSub}>{subtext}</Text>}
      </View>
      <TouchableOpacity
        style={[styles.toggle, value && styles.toggleOn]}
        onPress={onToggle}
      >
        <View style={[styles.toggleThumb, value && styles.toggleThumbOn]} />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f23" />

      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>

        <Section title="Security" />
        <View style={styles.card}>
          <ToggleRow
            label="Intruder Detection"
            subtext="Galat unlock pe photo lo"
            value={settings.intruderDetectionEnabled}
            onToggle={() => updateSettings({ intruderDetectionEnabled: !settings.intruderDetectionEnabled })}
          />
          <View style={styles.divider} />
          <Text style={styles.rowLabel}>Max Wrong Attempts</Text>
          <View style={styles.optionRow}>
            {[1, 2, 3, 5].map(n => (
              <TouchableOpacity
                key={n}
                style={[styles.optionBtn, settings.intruderMaxAttempts === n && styles.optionBtnActive]}
                onPress={() => updateSettings({ intruderMaxAttempts: n })}
              >
                <Text style={[styles.optionText, settings.intruderMaxAttempts === n && styles.optionTextActive]}>
                  {n}x
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <Section title="Focus Lock" />
        <View style={styles.card}>
          <ToggleRow
            label="Strict Mode"
            subtext="Focus mode todne ke liye passcode chahiye"
            value={settings.focusLockStrict}
            onToggle={() => updateSettings({ focusLockStrict: !settings.focusLockStrict })}
          />
          {settings.focusLockStrict && (
            <>
              <View style={styles.divider} />
              <Text style={styles.rowLabel}>Exit Passcode (4-6 digits)</Text>
              <View style={styles.passcodeRow}>
                <TextInput
                  style={styles.passcodeInput}
                  value={passcode}
                  onChangeText={setPasscode}
                  placeholder="Passcode..."
                  placeholderTextColor="#555"
                  keyboardType="numeric"
                  maxLength={6}
                  secureTextEntry
                />
                <TouchableOpacity style={styles.savePasscodeBtn} onPress={savePasscode}>
                  <Text style={styles.savePasscodeBtnText}>Save</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        <Section title="Reminders" />
        <View style={styles.card}>
          <Text style={styles.rowLabel}>Default Reminder Time</Text>
          <View style={styles.optionRow}>
            {[5, 10, 15, 30, 60].map(m => (
              <TouchableOpacity
                key={m}
                style={[styles.optionBtn, settings.defaultReminderMinutes === m && styles.optionBtnActive]}
                onPress={() => updateSettings({ defaultReminderMinutes: m })}
              >
                <Text style={[styles.optionText, settings.defaultReminderMinutes === m && styles.optionTextActive]}>
                  {m}m
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.actionBtn} onPress={requestNotificationPermission}>
            <Ionicons name="notifications-outline" size={18} color="#7c4dff" />
            <Text style={styles.actionBtnText}>Notification Permission</Text>
          </TouchableOpacity>
        </View>

        <Section title="App Info" />
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Version</Text>
            <Text style={styles.infoValue}>1.0.0</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Developer</Text>
            <Text style={styles.infoValue}>AP Partners</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>App Name</Text>
            <Text style={styles.infoValue}>AP FocusLock</Text>
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f23' },
  header: { padding: 20, paddingTop: 50 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  content: { paddingHorizontal: 16 },
  sectionTitle: { color: '#888', fontSize: 13, fontWeight: '600', letterSpacing: 1, marginTop: 24, marginBottom: 8, textTransform: 'uppercase' },
  card: { backgroundColor: '#1a1a35', borderRadius: 16, padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLabel: { color: '#e0e0e0', fontSize: 15, fontWeight: '500' },
  rowSub: { color: '#888', fontSize: 12, marginTop: 2 },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#333', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: '#7c4dff' },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  toggleThumbOn: { alignSelf: 'flex-end' },
  divider: { height: 1, backgroundColor: '#2a2a4a' },
  optionRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  optionBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: '#0f0f23', borderWidth: 1, borderColor: '#333' },
  optionBtnActive: { backgroundColor: '#7c4dff33', borderColor: '#7c4dff' },
  optionText: { color: '#888', fontWeight: '500' },
  optionTextActive: { color: '#7c4dff' },
  passcodeRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  passcodeInput: { flex: 1, backgroundColor: '#0f0f23', borderRadius: 10, padding: 12, color: '#fff', borderWidth: 1, borderColor: '#333', letterSpacing: 4 },
  savePasscodeBtn: { backgroundColor: '#7c4dff', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10 },
  savePasscodeBtnText: { color: '#fff', fontWeight: '600' },
  actionBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 4 },
  actionBtnText: { color: '#7c4dff', fontWeight: '500' },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  infoLabel: { color: '#888', fontSize: 14 },
  infoValue: { color: '#e0e0e0', fontSize: 14, fontWeight: '500' },
});
