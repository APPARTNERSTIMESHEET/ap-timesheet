import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Modal, Alert, StatusBar, Animated, Vibration, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useKeepAwake } from 'expo-keep-awake';
import { format, differenceInSeconds } from 'date-fns';
import { FocusSession, Target } from '../types';
import { useAppStore } from '../store/appStore';
import { NotificationService } from '../services/NotificationService';

const generateId = () => `focus_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const DURATIONS = [
  { label: '25 min', value: 25 },
  { label: '45 min', value: 45 },
  { label: '1 ghanta', value: 60 },
  { label: '2 ghante', value: 120 },
  { label: '3 ghante', value: 180 },
  { label: 'Custom', value: 0 },
];

export default function FocusModeScreen() {
  const { activeFocusSession, targets, settings, startFocusSession, endFocusSession } = useAppStore();
  const [selectedDuration, setSelectedDuration] = useState(25);
  const [customDuration, setCustomDuration] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [showEndModal, setShowEndModal] = useState(false);
  const [exitPasscode, setExitPasscode] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);
  const [showSetup, setShowSetup] = useState(!activeFocusSession);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Keep screen awake during focus
  useKeepAwake();

  useEffect(() => {
    if (activeFocusSession) {
      setShowSetup(false);
      const remaining = differenceInSeconds(new Date(activeFocusSession.endsAt), new Date());
      setTimeLeft(Math.max(0, remaining));
    } else {
      setShowSetup(true);
      setTimeLeft(0);
    }
  }, [activeFocusSession]);

  // Timer countdown
  useEffect(() => {
    if (!activeFocusSession || timeLeft <= 0) return;

    const interval = setInterval(() => {
      const remaining = differenceInSeconds(new Date(activeFocusSession.endsAt), new Date());
      if (remaining <= 0) {
        setTimeLeft(0);
        handleSessionEnd();
      } else {
        setTimeLeft(remaining);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [activeFocusSession, timeLeft]);

  // Pulse animation
  useEffect(() => {
    if (!activeFocusSession) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.05, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [activeFocusSession]);

  const handleSessionEnd = async () => {
    Vibration.vibrate([0, 500, 200, 500, 200, 500]);
    await endFocusSession();
    Alert.alert('Focus Complete!', 'Aapka focus session khatam hua. Shabash!');
  };

  const startSession = async () => {
    const duration = selectedDuration === 0
      ? parseInt(customDuration) || 25
      : selectedDuration;

    if (!sessionTitle.trim()) {
      Alert.alert('Error', 'Session ka naam dalo!');
      return;
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + duration * 60 * 1000);

    const session: FocusSession = {
      id: generateId(),
      title: sessionTitle,
      durationMinutes: duration,
      startedAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      isActive: true,
      blockedApps: [],
    };

    await startFocusSession(session);
    await NotificationService.scheduleFocusEnd(session.id, endsAt);

    Vibration.vibrate(200);
  };

  const requestEndSession = () => {
    if (settings.focusLockStrict) {
      if (!settings.passcode) {
        Alert.alert('Strict Mode', 'Timer khatam hone tak focus mode nahi hatega!');
        return;
      }
      setShowEndModal(true);
    } else {
      Alert.alert(
        'Focus Mode Band Karo?',
        'Kya aap sach mein focus mode todna chahte ho?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Haan', style: 'destructive', onPress: () => endFocusSession() },
        ]
      );
    }
  };

  const verifyPasscodeAndEnd = () => {
    if (exitPasscode === settings.passcode) {
      setShowEndModal(false);
      setExitPasscode('');
      endFocusSession();
    } else {
      Alert.alert('Galat Passcode', 'Sahi passcode daalo!');
      setExitPasscode('');
    }
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const totalSeconds = activeFocusSession
    ? differenceInSeconds(new Date(activeFocusSession.endsAt), new Date(activeFocusSession.startedAt))
    : 1;
  const progress = activeFocusSession
    ? Math.max(0, Math.min(1, 1 - timeLeft / totalSeconds))
    : 0;

  if (activeFocusSession && !showSetup) {
    return (
      <View style={styles.focusContainer}>
        <StatusBar barStyle="light-content" backgroundColor="#0a0a1a" />

        <View style={styles.focusHeader}>
          <Ionicons name="lock-closed" size={20} color="#9c27b0" />
          <Text style={styles.focusModeLabel}>FOCUS MODE ON</Text>
        </View>

        <Text style={styles.focusTitle}>{activeFocusSession.title}</Text>

        <Animated.View style={[styles.timerCircle, { transform: [{ scale: pulseAnim }] }]}>
          <View style={styles.timerInner}>
            <Text style={styles.timerText}>{formatTime(timeLeft)}</Text>
            <Text style={styles.timerLabel}>baaki hai</Text>
          </View>
        </Animated.View>

        {/* Progress bar */}
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>
        <Text style={styles.progressText}>{Math.round(progress * 100)}% complete</Text>

        <View style={styles.focusInfo}>
          <Text style={styles.focusInfoText}>
            Shuru: {format(new Date(activeFocusSession.startedAt), 'hh:mm a')}
          </Text>
          <Text style={styles.focusInfoText}>
            Khatam: {format(new Date(activeFocusSession.endsAt), 'hh:mm a')}
          </Text>
        </View>

        <View style={styles.focusTips}>
          <Text style={styles.tipTitle}>Focus Tips</Text>
          <Text style={styles.tipText}>• Phone side mein rakh do</Text>
          <Text style={styles.tipText}>• Ek kaam pe focus karo</Text>
          <Text style={styles.tipText}>• Beech mein mat uthna</Text>
        </View>

        <TouchableOpacity style={styles.endBtn} onPress={requestEndSession}>
          <Ionicons name="stop-circle-outline" size={20} color="#f44336" />
          <Text style={styles.endBtnText}>Focus Mode Band Karo</Text>
        </TouchableOpacity>

        {/* Passcode modal */}
        <Modal visible={showEndModal} transparent animationType="fade">
          <View style={styles.passcodeOverlay}>
            <View style={styles.passcodeCard}>
              <Text style={styles.passcodeTitle}>Passcode Daalo</Text>
              <Text style={styles.passcodeSub}>Focus mode todne ke liye passcode chahiye</Text>
              <TextInput
                style={styles.passcodeInput}
                value={exitPasscode}
                onChangeText={setExitPasscode}
                keyboardType="numeric"
                maxLength={6}
                secureTextEntry
                placeholder="••••"
                placeholderTextColor="#555"
              />
              <View style={styles.passcodeButtons}>
                <TouchableOpacity
                  style={styles.passcodeCancelBtn}
                  onPress={() => { setShowEndModal(false); setExitPasscode(''); }}
                >
                  <Text style={styles.passcodeCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.passcodeConfirmBtn} onPress={verifyPasscodeAndEnd}>
                  <Text style={styles.passcodeConfirmText}>Confirm</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f23" />

      <View style={styles.header}>
        <Text style={styles.title}>Focus Mode</Text>
        <Ionicons name="lock-closed" size={24} color="#9c27b0" />
      </View>

      <View style={styles.setupCard}>
        <Text style={styles.label}>Session Ka Naam</Text>
        <TextInput
          style={styles.input}
          value={sessionTitle}
          onChangeText={setSessionTitle}
          placeholder="kya karne wale ho?"
          placeholderTextColor="#555"
        />

        <Text style={styles.label}>Duration</Text>
        <View style={styles.durationGrid}>
          {DURATIONS.map(d => (
            <TouchableOpacity
              key={d.label}
              style={[styles.durationBtn, selectedDuration === d.value && styles.durationBtnActive]}
              onPress={() => setSelectedDuration(d.value)}
            >
              <Text style={[styles.durationText, selectedDuration === d.value && styles.durationTextActive]}>
                {d.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {selectedDuration === 0 && (
          <TextInput
            style={styles.input}
            value={customDuration}
            onChangeText={setCustomDuration}
            placeholder="Minutes mein duration likho"
            placeholderTextColor="#555"
            keyboardType="numeric"
          />
        )}
      </View>

      <View style={styles.infoCard}>
        <Ionicons name="information-circle-outline" size={20} color="#9c27b0" />
        <Text style={styles.infoText}>
          Focus mode mein phone ka use restrict ho jata hai.
          {settings.focusLockStrict ? ' Strict mode on hai - passcode chahiye exit karne ke liye.' : ' Kisi bhi waqt band kar sakte ho.'}
        </Text>
      </View>

      <TouchableOpacity style={styles.startBtn} onPress={startSession}>
        <Ionicons name="play" size={22} color="#fff" />
        <Text style={styles.startBtnText}>Focus Shuru Karo</Text>
      </TouchableOpacity>

      {/* Past sessions info */}
      <Text style={styles.tipsTitle}>Pomodoro Technique</Text>
      <View style={styles.tipsCard}>
        <Text style={styles.tipItem}>🎯 25 min focus + 5 min break</Text>
        <Text style={styles.tipItem}>🔁 4 pomodoros ke baad 15-30 min break</Text>
        <Text style={styles.tipItem}>📵 Phone notifications band karo</Text>
        <Text style={styles.tipItem}>✍️ Ek hi kaam karo ek waqt mein</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f23', padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 30, marginBottom: 24 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  setupCard: { backgroundColor: '#1a1a35', borderRadius: 16, padding: 16, marginBottom: 16 },
  label: { color: '#aaa', fontSize: 13, marginBottom: 8, marginTop: 12 },
  input: { backgroundColor: '#0f0f23', borderRadius: 10, padding: 12, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#2a2a4a' },
  durationGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  durationBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, backgroundColor: '#0f0f23', borderWidth: 1, borderColor: '#333' },
  durationBtnActive: { backgroundColor: '#9c27b033', borderColor: '#9c27b0' },
  durationText: { color: '#888', fontWeight: '500' },
  durationTextActive: { color: '#9c27b0' },
  infoCard: { flexDirection: 'row', gap: 10, backgroundColor: '#1a0a2e', borderRadius: 12, padding: 14, marginBottom: 16, alignItems: 'flex-start' },
  infoText: { color: '#aaa', fontSize: 13, flex: 1, lineHeight: 20 },
  startBtn: { backgroundColor: '#9c27b0', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 24 },
  startBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 17 },
  tipsTitle: { color: '#aaa', fontWeight: '600', marginBottom: 10 },
  tipsCard: { backgroundColor: '#1a1a35', borderRadius: 14, padding: 16, gap: 10 },
  tipItem: { color: '#ccc', fontSize: 14 },

  // Active focus screen
  focusContainer: { flex: 1, backgroundColor: '#0a0a1a', alignItems: 'center', padding: 24 },
  focusHeader: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 50 },
  focusModeLabel: { color: '#9c27b0', fontWeight: 'bold', fontSize: 13, letterSpacing: 2 },
  focusTitle: { color: '#fff', fontSize: 22, fontWeight: 'bold', marginTop: 16, textAlign: 'center' },
  timerCircle: {
    width: 220, height: 220, borderRadius: 110,
    borderWidth: 4, borderColor: '#9c27b0',
    alignItems: 'center', justifyContent: 'center',
    marginVertical: 40,
    backgroundColor: '#1a0a2e',
    shadowColor: '#9c27b0', shadowOpacity: 0.4, shadowRadius: 20, elevation: 10,
  },
  timerInner: { alignItems: 'center' },
  timerText: { color: '#fff', fontSize: 52, fontWeight: 'bold', letterSpacing: 2 },
  timerLabel: { color: '#9c27b0', fontSize: 14, marginTop: 4 },
  progressBar: { width: '80%', height: 6, backgroundColor: '#2a2a4a', borderRadius: 3, marginBottom: 8 },
  progressFill: { height: 6, backgroundColor: '#9c27b0', borderRadius: 3 },
  progressText: { color: '#888', fontSize: 13 },
  focusInfo: { flexDirection: 'row', gap: 20, marginTop: 24 },
  focusInfoText: { color: '#888', fontSize: 13 },
  focusTips: { width: '100%', backgroundColor: '#1a1a35', borderRadius: 14, padding: 16, marginTop: 24, gap: 8 },
  tipTitle: { color: '#aaa', fontWeight: '600', marginBottom: 4 },
  tipText: { color: '#666', fontSize: 13 },
  endBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 30, padding: 14, borderRadius: 30, borderWidth: 1, borderColor: '#f44336' },
  endBtnText: { color: '#f44336', fontWeight: '600' },

  // Passcode modal
  passcodeOverlay: { flex: 1, backgroundColor: '#000000cc', alignItems: 'center', justifyContent: 'center' },
  passcodeCard: { backgroundColor: '#1a1a35', borderRadius: 20, padding: 28, width: '80%', alignItems: 'center' },
  passcodeTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginBottom: 8 },
  passcodeSub: { color: '#888', fontSize: 13, textAlign: 'center', marginBottom: 20 },
  passcodeInput: { backgroundColor: '#0f0f23', borderRadius: 12, padding: 14, color: '#fff', fontSize: 24, textAlign: 'center', width: '100%', borderWidth: 1, borderColor: '#333', letterSpacing: 8 },
  passcodeButtons: { flexDirection: 'row', gap: 12, marginTop: 20 },
  passcodeCancelBtn: { flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#333', alignItems: 'center' },
  passcodeCancelText: { color: '#aaa', fontWeight: '600' },
  passcodeConfirmBtn: { flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#9c27b0', alignItems: 'center' },
  passcodeConfirmText: { color: '#fff', fontWeight: '600' },
});
