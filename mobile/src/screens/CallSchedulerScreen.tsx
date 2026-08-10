import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, Modal, ScrollView, Alert, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { format, isPast } from 'date-fns';
import { CallSchedule } from '../types';
import { useAppStore } from '../store/appStore';
import { CallService } from '../services/CallService';
import { NotificationService } from '../services/NotificationService';
import * as Contacts from 'expo-contacts';

const generateId = () => `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function CallSchedulerScreen() {
  const { callSchedules, addCallSchedule, updateCallSchedule, deleteCallSchedule } = useAppStore();
  const [showModal, setShowModal] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [scheduledDate, setScheduledDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [scheduledTime, setScheduledTime] = useState('');
  const [note, setNote] = useState('');
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringDays, setRecurringDays] = useState<number[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [contactResults, setContactResults] = useState<Contacts.Contact[]>([]);
  const [filter, setFilter] = useState<'upcoming' | 'overdue' | 'all'>('upcoming');

  useEffect(() => {
    CallService.requestContactsPermission();
    NotificationService.requestPermissions();
  }, []);

  const searchContacts = async (q: string) => {
    setContactSearch(q);
    if (q.length < 2) { setContactResults([]); return; }
    const results = await CallService.searchContacts(q);
    setContactResults(results);
  };

  const selectContact = (contact: Contacts.Contact) => {
    setContactName(contact.name || '');
    const phone = contact.phoneNumbers?.[0]?.number || '';
    setContactPhone(phone);
    setContactSearch('');
    setContactResults([]);
  };

  const handleSave = async () => {
    if (!contactName.trim() || !contactPhone.trim()) {
      Alert.alert('Error', 'Contact name aur phone number dalo!');
      return;
    }
    if (!scheduledTime.trim()) {
      Alert.alert('Error', 'Time dalo!');
      return;
    }

    const dateTime = new Date(`${scheduledDate}T${scheduledTime}:00`);
    if (isNaN(dateTime.getTime())) {
      Alert.alert('Error', 'Valid date/time dalo! Format: yyyy-mm-dd aur HH:MM');
      return;
    }

    const call: CallSchedule = {
      id: generateId(),
      contactName: contactName.trim(),
      contactPhone: contactPhone.trim(),
      scheduledAt: dateTime.toISOString(),
      note: note.trim() || undefined,
      isRecurring,
      recurringDays: isRecurring ? recurringDays : undefined,
      recurringTime: isRecurring ? scheduledTime : undefined,
      isCompleted: false,
      createdAt: new Date().toISOString(),
    };

    await addCallSchedule(call);
    await CallService.scheduleCall(call);
    resetForm();
    setShowModal(false);
    Alert.alert('Done!', `${contactName} ko ${format(dateTime, 'dd MMM, hh:mm a')} pe reminder set ho gaya!`);
  };

  const resetForm = () => {
    setContactName(''); setContactPhone(''); setNote('');
    setScheduledDate(format(new Date(), 'yyyy-MM-dd'));
    setScheduledTime(''); setIsRecurring(false); setRecurringDays([]);
  };

  const handleCallNow = async (call: CallSchedule) => {
    const success = await CallService.makeCall(call.contactPhone);
    if (success) {
      await updateCallSchedule(call.id, { isCompleted: true });
    } else {
      Alert.alert('Error', 'Call nahi ho saki. Number check karo.');
    }
  };

  const handleDelete = (call: CallSchedule) => {
    Alert.alert(
      'Delete',
      `${call.contactName} ki call schedule delete karo?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteCallSchedule(call.id) },
      ]
    );
  };

  const toggleDay = (day: number) => {
    setRecurringDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    );
  };

  const filtered = callSchedules.filter(c => {
    if (filter === 'upcoming') return !c.isCompleted && !isPast(new Date(c.scheduledAt));
    if (filter === 'overdue') return !c.isCompleted && isPast(new Date(c.scheduledAt));
    return true;
  }).sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f23" />

      <View style={styles.header}>
        <Text style={styles.title}>Call Scheduler</Text>
        <TouchableOpacity style={styles.addBtn} onPress={() => setShowModal(true)}>
          <Ionicons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Filters */}
      <View style={styles.filterRow}>
        {(['upcoming', 'overdue', 'all'] as const).map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterTab, filter === f && styles.filterTabActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f === 'upcoming' ? 'Aane Wale' : f === 'overdue' ? 'Miss Hue' : 'Sab'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={c => c.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="call-outline" size={60} color="#333" />
            <Text style={styles.emptyText}>Koi call schedule nahi</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => setShowModal(true)}>
              <Text style={styles.emptyBtnText}>+ Call Schedule Karo</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item: call }) => {
          const isOverdue = !call.isCompleted && isPast(new Date(call.scheduledAt));
          return (
            <View style={[styles.callCard, call.isCompleted && styles.callCardDone, isOverdue && styles.callCardOverdue]}>
              <View style={[styles.callAvatar, { backgroundColor: isOverdue ? '#f4433633' : '#2196f333' }]}>
                <Text style={styles.callAvatarText}>
                  {call.contactName.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={styles.callBody}>
                <Text style={[styles.callName, call.isCompleted && styles.textDone]}>
                  {call.contactName}
                  {call.isRecurring && <Text style={styles.recurringTag}> 🔁</Text>}
                </Text>
                <Text style={styles.callNumber}>
                  {CallService.formatPhoneForDisplay(call.contactPhone)}
                </Text>
                <Text style={[styles.callTime, isOverdue && styles.overdueText]}>
                  {format(new Date(call.scheduledAt), 'dd MMM yyyy, hh:mm a')}
                  {isOverdue ? ' (Miss hua!)' : ''}
                </Text>
                {call.note && <Text style={styles.callNote}>{call.note}</Text>}
              </View>
              <View style={styles.callActions}>
                {!call.isCompleted && (
                  <TouchableOpacity style={styles.callNowBtn} onPress={() => handleCallNow(call)}>
                    <Ionicons name="call" size={18} color="#fff" />
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => handleDelete(call)} style={styles.deleteBtn}>
                  <Ionicons name="trash-outline" size={16} color="#f44336" />
                </TouchableOpacity>
              </View>
            </View>
          );
        }}
      />

      {/* Add Modal */}
      <Modal visible={showModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Call Schedule Karo</Text>
              <TouchableOpacity onPress={() => { setShowModal(false); resetForm(); }}>
                <Ionicons name="close" size={24} color="#888" />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.label}>Contact Dhundo</Text>
              <TextInput
                style={styles.input}
                value={contactSearch}
                onChangeText={searchContacts}
                placeholder="Naam ya number se search karo..."
                placeholderTextColor="#555"
              />
              {contactResults.map(c => (
                <TouchableOpacity
                  key={c.id}
                  style={styles.contactResult}
                  onPress={() => selectContact(c)}
                >
                  <Text style={styles.contactResultName}>{c.name}</Text>
                  <Text style={styles.contactResultNum}>{c.phoneNumbers?.[0]?.number}</Text>
                </TouchableOpacity>
              ))}

              <Text style={styles.label}>Naam</Text>
              <TextInput
                style={styles.input}
                value={contactName}
                onChangeText={setContactName}
                placeholder="Contact ka naam..."
                placeholderTextColor="#555"
              />

              <Text style={styles.label}>Phone Number</Text>
              <TextInput
                style={styles.input}
                value={contactPhone}
                onChangeText={setContactPhone}
                placeholder="+91 98765 43210"
                placeholderTextColor="#555"
                keyboardType="phone-pad"
              />

              <Text style={styles.label}>Date (yyyy-mm-dd)</Text>
              <TextInput
                style={styles.input}
                value={scheduledDate}
                onChangeText={setScheduledDate}
                placeholder="2025-12-31"
                placeholderTextColor="#555"
              />

              <Text style={styles.label}>Time (HH:MM, 24-hour)</Text>
              <TextInput
                style={styles.input}
                value={scheduledTime}
                onChangeText={setScheduledTime}
                placeholder="14:30"
                placeholderTextColor="#555"
              />

              <Text style={styles.label}>Note (Optional)</Text>
              <TextInput
                style={styles.input}
                value={note}
                onChangeText={setNote}
                placeholder="Call ke baare mein kuch note..."
                placeholderTextColor="#555"
              />

              <View style={styles.switchRow}>
                <Text style={styles.label}>Recurring Call?</Text>
                <TouchableOpacity
                  style={[styles.toggle, isRecurring && styles.toggleOn]}
                  onPress={() => setIsRecurring(r => !r)}
                >
                  <View style={[styles.toggleThumb, isRecurring && styles.toggleThumbOn]} />
                </TouchableOpacity>
              </View>

              {isRecurring && (
                <>
                  <Text style={styles.label}>Kaunse din?</Text>
                  <View style={styles.daysRow}>
                    {DAYS.map((day, i) => (
                      <TouchableOpacity
                        key={day}
                        style={[styles.dayBtn, recurringDays.includes(i) && styles.dayBtnActive]}
                        onPress={() => toggleDay(i)}
                      >
                        <Text style={[styles.dayText, recurringDays.includes(i) && styles.dayTextActive]}>
                          {day}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                <Text style={styles.saveBtnText}>Schedule Karo</Text>
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
  addBtn: { backgroundColor: '#2196f3', width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  filterRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 16 },
  filterTab: { flex: 1, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a35', alignItems: 'center' },
  filterTabActive: { backgroundColor: '#2196f3' },
  filterText: { color: '#888', fontWeight: '500', fontSize: 12 },
  filterTextActive: { color: '#fff' },
  list: { padding: 16, gap: 12, paddingBottom: 100 },
  empty: { alignItems: 'center', marginTop: 80, gap: 16 },
  emptyText: { color: '#555', fontSize: 16 },
  emptyBtn: { backgroundColor: '#2196f3', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 25 },
  emptyBtnText: { color: '#fff', fontWeight: '600' },
  callCard: { backgroundColor: '#1a1a35', borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  callCardDone: { opacity: 0.5 },
  callCardOverdue: { borderLeftWidth: 3, borderLeftColor: '#f44336' },
  callAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  callAvatarText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  callBody: { flex: 1 },
  callName: { color: '#fff', fontWeight: '600', fontSize: 16 },
  textDone: { textDecorationLine: 'line-through', color: '#555' },
  recurringTag: { fontSize: 14 },
  callNumber: { color: '#888', fontSize: 13, marginTop: 2 },
  callTime: { color: '#2196f3', fontSize: 12, marginTop: 2 },
  overdueText: { color: '#f44336' },
  callNote: { color: '#666', fontSize: 12, marginTop: 3, fontStyle: 'italic' },
  callActions: { gap: 8 },
  callNowBtn: { backgroundColor: '#2196f3', width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  deleteBtn: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  modalOverlay: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#1a1a35', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff' },
  label: { color: '#aaa', fontSize: 13, marginBottom: 6, marginTop: 14 },
  input: { backgroundColor: '#0f0f23', borderRadius: 10, padding: 12, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#2a2a4a' },
  contactResult: { backgroundColor: '#0f0f23', padding: 12, borderRadius: 8, marginTop: 4 },
  contactResultName: { color: '#fff', fontWeight: '500' },
  contactResultNum: { color: '#888', fontSize: 13 },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#333', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: '#2196f3' },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  toggleThumbOn: { alignSelf: 'flex-end' },
  daysRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  dayBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: '#0f0f23', borderWidth: 1, borderColor: '#333' },
  dayBtnActive: { backgroundColor: '#2196f333', borderColor: '#2196f3' },
  dayText: { color: '#888', fontWeight: '500', fontSize: 12 },
  dayTextActive: { color: '#2196f3' },
  saveBtn: { backgroundColor: '#2196f3', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24, marginBottom: 10 },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
});
