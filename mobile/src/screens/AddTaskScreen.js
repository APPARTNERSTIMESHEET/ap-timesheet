import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import uuid from 'react-native-uuid';
import { COLORS, SPACING, RADIUS } from '../theme';
import { addTask, updateTask } from '../storage/storage';

const PRIORITIES = ['high', 'medium', 'low'];
const PRIORITY_COLORS = { high: COLORS.danger, medium: COLORS.warning, low: COLORS.accent };

export default function AddTaskScreen({ navigation, route }) {
  const existing = route.params?.task;
  const [title, setTitle] = useState(existing?.title || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [priority, setPriority] = useState(existing?.priority || 'medium');
  const [dueDate, setDueDate] = useState(existing ? new Date(existing.dueDate) : new Date());
  const [dueTime, setDueTime] = useState(existing?.dueTime || '');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [timeDate, setTimeDate] = useState(new Date());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    navigation.setOptions({ title: existing ? 'Edit Task' : 'New Task' });
  }, []);

  const validate = () => {
    const e = {};
    if (!title.trim()) e.title = 'Title is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    const task = {
      id: existing?.id || uuid.v4(),
      title: title.trim(),
      description: description.trim(),
      priority,
      dueDate: dueDate.toISOString(),
      dueTime,
      completed: existing?.completed || false,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    if (existing) {
      await updateTask(existing.id, task);
    } else {
      await addTask(task);
    }
    navigation.goBack();
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

      {/* Title */}
      <Label>Task Title *</Label>
      <TextInput
        style={[styles.input, errors.title && styles.inputError]}
        placeholder="What needs to be done?"
        placeholderTextColor={COLORS.textMuted}
        value={title}
        onChangeText={setTitle}
      />
      {errors.title && <Text style={styles.errorText}>{errors.title}</Text>}

      {/* Description */}
      <Label>Description</Label>
      <TextInput
        style={[styles.input, styles.inputMulti]}
        placeholder="Optional details..."
        placeholderTextColor={COLORS.textMuted}
        value={description}
        onChangeText={setDescription}
        multiline
        numberOfLines={3}
        textAlignVertical="top"
      />

      {/* Priority */}
      <Label>Priority</Label>
      <View style={styles.priorities}>
        {PRIORITIES.map(p => (
          <TouchableOpacity
            key={p}
            style={[styles.priorityBtn, priority === p && { backgroundColor: PRIORITY_COLORS[p], borderColor: PRIORITY_COLORS[p] }]}
            onPress={() => setPriority(p)}
          >
            <Text style={[styles.priorityBtnText, priority === p && styles.priorityBtnTextActive]}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Due Date */}
      <Label>Due Date</Label>
      <TouchableOpacity style={styles.picker} onPress={() => setShowDatePicker(true)}>
        <Ionicons name="calendar-outline" size={18} color={COLORS.primary} />
        <Text style={styles.pickerText}>
          {dueDate.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}
        </Text>
      </TouchableOpacity>
      {showDatePicker && (
        <DateTimePicker
          value={dueDate}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          minimumDate={new Date()}
          onChange={(_, d) => { setShowDatePicker(false); if (d) setDueDate(d); }}
        />
      )}

      {/* Due Time (optional) */}
      <Label>Due Time (optional)</Label>
      <TouchableOpacity style={styles.picker} onPress={() => setShowTimePicker(true)}>
        <Ionicons name="time-outline" size={18} color={COLORS.primary} />
        <Text style={styles.pickerText}>{dueTime || 'No specific time'}</Text>
        {dueTime ? (
          <TouchableOpacity onPress={() => setDueTime('')} style={styles.clearBtn}>
            <Ionicons name="close-circle" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
      {showTimePicker && (
        <DateTimePicker
          value={timeDate}
          mode="time"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(_, d) => {
            setShowTimePicker(false);
            if (d) {
              setTimeDate(d);
              setDueTime(d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }));
            }
          }}
        />
      )}

      {/* Save Button */}
      <TouchableOpacity style={styles.saveBtn} onPress={save}>
        <Ionicons name="checkmark" size={20} color={COLORS.text} />
        <Text style={styles.saveBtnText}>{existing ? 'Update Task' : 'Add Task'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Label({ children }) {
  return <Text style={styles.label}>{children}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, paddingBottom: 48 },
  label: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: SPACING.md, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: COLORS.card, color: COLORS.text, borderRadius: RADIUS.md, padding: SPACING.md, fontSize: 15, borderWidth: 1, borderColor: COLORS.border },
  inputMulti: { minHeight: 80 },
  inputError: { borderColor: COLORS.danger },
  errorText: { color: COLORS.danger, fontSize: 12, marginTop: 4 },
  priorities: { flexDirection: 'row', gap: SPACING.sm },
  priorityBtn: { flex: 1, padding: 10, borderRadius: RADIUS.md, borderWidth: 1.5, borderColor: COLORS.border, alignItems: 'center' },
  priorityBtnText: { color: COLORS.textSecondary, fontWeight: '600', fontSize: 14 },
  priorityBtnTextActive: { color: COLORS.text },
  picker: { backgroundColor: COLORS.card, borderRadius: RADIUS.md, padding: SPACING.md, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: COLORS.border },
  pickerText: { flex: 1, color: COLORS.text, fontSize: 15 },
  clearBtn: { padding: 2 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary, borderRadius: RADIUS.round, padding: SPACING.md, marginTop: SPACING.xl, gap: 8 },
  saveBtnText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
});
