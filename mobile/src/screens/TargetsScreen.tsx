import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, Modal, ScrollView, Alert, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { format, differenceInDays, isPast } from 'date-fns';
import { Target } from '../types';
import { useAppStore } from '../store/appStore';

const generateId = () => `target_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export default function TargetsScreen() {
  const { targets, tasks, addTarget, updateTarget, deleteTarget } = useAppStore();
  const [showModal, setShowModal] = useState(false);
  const [editingTarget, setEditingTarget] = useState<Target | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [focusLockEnabled, setFocusLockEnabled] = useState(false);
  const [focusDuration, setFocusDuration] = useState('60');

  const openAdd = () => {
    setEditingTarget(null);
    setTitle(''); setDescription('');
    setDeadline(''); setFocusLockEnabled(false); setFocusDuration('60');
    setShowModal(true);
  };

  const openEdit = (target: Target) => {
    setEditingTarget(target);
    setTitle(target.title);
    setDescription(target.description || '');
    setDeadline(target.deadline.split('T')[0]);
    setFocusLockEnabled(target.focusLockEnabled);
    setFocusDuration(String(target.focusLockDurationMinutes));
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!title.trim()) { Alert.alert('Error', 'Target ka naam dalo!'); return; }
    if (!deadline.trim()) { Alert.alert('Error', 'Deadline dalo!'); return; }

    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime())) {
      Alert.alert('Error', 'Valid date dalo! Format: yyyy-mm-dd');
      return;
    }

    if (editingTarget) {
      await updateTarget(editingTarget.id, {
        title: title.trim(), description: description.trim(),
        deadline: deadlineDate.toISOString(),
        focusLockEnabled, focusLockDurationMinutes: parseInt(focusDuration) || 60,
      });
    } else {
      const target: Target = {
        id: generateId(),
        title: title.trim(), description: description.trim(),
        deadline: deadlineDate.toISOString(),
        focusLockEnabled, focusLockDurationMinutes: parseInt(focusDuration) || 60,
        progress: 0, tasks: [],
        createdAt: new Date().toISOString(),
      };
      await addTarget(target);
    }
    setShowModal(false);
  };

  const updateProgress = async (target: Target, delta: number) => {
    const newProgress = Math.max(0, Math.min(100, target.progress + delta));
    await updateTarget(target.id, { progress: newProgress });
  };

  const handleDelete = (target: Target) => {
    Alert.alert('Delete', `"${target.title}" delete karo?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteTarget(target.id) },
    ]);
  };

  const getStatusColor = (target: Target) => {
    if (isPast(new Date(target.deadline))) return '#f44336';
    const days = differenceInDays(new Date(target.deadline), new Date());
    if (days <= 3) return '#ff9800';
    return '#4caf50';
  };

  const getStatusLabel = (target: Target) => {
    if (isPast(new Date(target.deadline))) return 'Expired!';
    const days = differenceInDays(new Date(target.deadline), new Date());
    if (days === 0) return 'Aaj!';
    if (days === 1) return 'Kal!';
    return `${days} din baaki`;
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f23" />

      <View style={styles.header}>
        <Text style={styles.title}>Targets</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openAdd}>
          <Ionicons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      <FlatList
        data={targets.sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())}
        keyExtractor={t => t.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="flag-outline" size={60} color="#333" />
            <Text style={styles.emptyText}>Koi target set nahi hai</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={openAdd}>
              <Text style={styles.emptyBtnText}>+ Target Set Karo</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item: target }) => {
          const statusColor = getStatusColor(target);
          const daysLeft = getStatusLabel(target);
          return (
            <TouchableOpacity style={styles.targetCard} onLongPress={() => openEdit(target)}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.targetTitle}>{target.title}</Text>
                  {target.description ? (
                    <Text style={styles.targetDesc} numberOfLines={2}>{target.description}</Text>
                  ) : null}
                </View>
                <TouchableOpacity onPress={() => handleDelete(target)} style={styles.deleteBtn}>
                  <Ionicons name="trash-outline" size={16} color="#555" />
                </TouchableOpacity>
              </View>

              {/* Progress bar */}
              <View style={styles.progressRow}>
                <View style={styles.progressBg}>
                  <View style={[styles.progressFill, { width: `${target.progress}%`, backgroundColor: statusColor }]} />
                </View>
                <Text style={[styles.progressText, { color: statusColor }]}>{target.progress}%</Text>
              </View>

              {/* Progress controls */}
              <View style={styles.progressControls}>
                <TouchableOpacity style={styles.progressBtn} onPress={() => updateProgress(target, -10)}>
                  <Ionicons name="remove" size={18} color="#aaa" />
                </TouchableOpacity>
                <Text style={styles.progressLabel}>Progress</Text>
                <TouchableOpacity style={styles.progressBtn} onPress={() => updateProgress(target, 10)}>
                  <Ionicons name="add" size={18} color="#aaa" />
                </TouchableOpacity>
              </View>

              <View style={styles.cardMeta}>
                <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
                  <Ionicons name="time-outline" size={12} color={statusColor} />
                  <Text style={[styles.statusText, { color: statusColor }]}>
                    Deadline: {format(new Date(target.deadline), 'dd MMM yyyy')} • {daysLeft}
                  </Text>
                </View>
                {target.focusLockEnabled && (
                  <View style={styles.focusBadge}>
                    <Ionicons name="lock-closed" size={12} color="#9c27b0" />
                    <Text style={styles.focusBadgeText}>{target.focusLockDurationMinutes}m focus</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
      />

      <Modal visible={showModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingTarget ? 'Target Edit Karo' : 'Naya Target'}
              </Text>
              <TouchableOpacity onPress={() => setShowModal(false)}>
                <Ionicons name="close" size={24} color="#888" />
              </TouchableOpacity>
            </View>
            <ScrollView>
              <Text style={styles.label}>Target Ka Naam *</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                placeholder="Kya achieve karna hai?"
                placeholderTextColor="#555"
              />

              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                value={description}
                onChangeText={setDescription}
                placeholder="Target ki details..."
                placeholderTextColor="#555"
                multiline
              />

              <Text style={styles.label}>Deadline (yyyy-mm-dd) *</Text>
              <TextInput
                style={styles.input}
                value={deadline}
                onChangeText={setDeadline}
                placeholder="2025-12-31"
                placeholderTextColor="#555"
              />

              <View style={styles.switchRow}>
                <View>
                  <Text style={styles.label}>Focus Lock Mode</Text>
                  <Text style={styles.switchHint}>Is target pe kaam karte waqt phone lock ho jae</Text>
                </View>
                <TouchableOpacity
                  style={[styles.toggle, focusLockEnabled && styles.toggleOn]}
                  onPress={() => setFocusLockEnabled(v => !v)}
                >
                  <View style={[styles.toggleThumb, focusLockEnabled && styles.toggleThumbOn]} />
                </TouchableOpacity>
              </View>

              {focusLockEnabled && (
                <>
                  <Text style={styles.label}>Focus Duration (minutes)</Text>
                  <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    {[25, 45, 60, 90, 120].map(m => (
                      <TouchableOpacity
                        key={m}
                        style={[styles.optionBtn, parseInt(focusDuration) === m && styles.optionBtnActive]}
                        onPress={() => setFocusDuration(String(m))}
                      >
                        <Text style={[styles.optionText, parseInt(focusDuration) === m && styles.optionTextActive]}>
                          {m}m
                        </Text>
                      </TouchableOpacity>
                    ))}
                    <TextInput
                      style={[styles.input, { width: 80, textAlign: 'center' }]}
                      value={focusDuration}
                      onChangeText={setFocusDuration}
                      keyboardType="numeric"
                      placeholder="min"
                      placeholderTextColor="#555"
                    />
                  </View>
                </>
              )}

              <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                <Text style={styles.saveBtnText}>
                  {editingTarget ? 'Update Karo' : 'Add Karo'}
                </Text>
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
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  addBtn: { backgroundColor: '#ff9800', width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 14, paddingBottom: 100 },
  empty: { alignItems: 'center', marginTop: 80, gap: 16 },
  emptyText: { color: '#555', fontSize: 16 },
  emptyBtn: { backgroundColor: '#ff9800', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 25 },
  emptyBtnText: { color: '#fff', fontWeight: '600' },
  targetCard: { backgroundColor: '#1a1a35', borderRadius: 16, padding: 16, gap: 10 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  targetTitle: { color: '#fff', fontWeight: '700', fontSize: 17 },
  targetDesc: { color: '#888', fontSize: 13, marginTop: 4, lineHeight: 18 },
  deleteBtn: { padding: 4 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  progressBg: { flex: 1, height: 8, backgroundColor: '#2a2a4a', borderRadius: 4 },
  progressFill: { height: 8, borderRadius: 4 },
  progressText: { fontWeight: 'bold', fontSize: 13, minWidth: 35 },
  progressControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20 },
  progressBtn: { backgroundColor: '#2a2a4a', width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  progressLabel: { color: '#666', fontSize: 12 },
  cardMeta: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  statusBadge: { flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, alignItems: 'center' },
  statusText: { fontSize: 11, fontWeight: '600' },
  focusBadge: { flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, backgroundColor: '#9c27b022', alignItems: 'center' },
  focusBadgeText: { color: '#9c27b0', fontSize: 11, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#1a1a35', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff' },
  label: { color: '#aaa', fontSize: 13, marginBottom: 6, marginTop: 14 },
  input: { backgroundColor: '#0f0f23', borderRadius: 10, padding: 12, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#2a2a4a' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  switchHint: { color: '#666', fontSize: 12, marginTop: 2 },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#333', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: '#ff9800' },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  toggleThumbOn: { alignSelf: 'flex-end' },
  optionBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#0f0f23', borderWidth: 1, borderColor: '#333' },
  optionBtnActive: { backgroundColor: '#ff980033', borderColor: '#ff9800' },
  optionText: { color: '#888', fontWeight: '500' },
  optionTextActive: { color: '#ff9800' },
  saveBtn: { backgroundColor: '#ff9800', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24, marginBottom: 10 },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
});
