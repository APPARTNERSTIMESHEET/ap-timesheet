import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, Modal, ScrollView, Alert, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { Task, Priority } from '../types';
import { useAppStore } from '../store/appStore';
import { NotificationService } from '../services/NotificationService';

const generateId = () => `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const CATEGORIES = ['Kaam', 'Personal', 'Health', 'Study', 'Family', 'Finance', 'Other'];
const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: 'high', label: 'High', color: '#f44336' },
  { value: 'medium', label: 'Medium', color: '#ff9800' },
  { value: 'low', label: 'Low', color: '#4caf50' },
];

interface TaskFormData {
  title: string;
  description: string;
  priority: Priority;
  dueDate: string;
  dueTime: string;
  reminderEnabled: boolean;
  reminderMinutesBefore: number;
  category: string;
}

export default function TasksScreen() {
  const { tasks, addTask, updateTask, deleteTask } = useAppStore();
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed'>('all');
  const [showModal, setShowModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [form, setForm] = useState<TaskFormData>({
    title: '',
    description: '',
    priority: 'medium',
    dueDate: format(new Date(), 'yyyy-MM-dd'),
    dueTime: '',
    reminderEnabled: true,
    reminderMinutesBefore: 15,
    category: 'Kaam',
  });

  const filteredTasks = tasks.filter(t => {
    if (filter === 'pending') return t.status !== 'completed';
    if (filter === 'completed') return t.status === 'completed';
    return true;
  }).sort((a, b) => {
    const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  const openAdd = () => {
    setEditingTask(null);
    setForm({
      title: '', description: '', priority: 'medium',
      dueDate: format(new Date(), 'yyyy-MM-dd'), dueTime: '',
      reminderEnabled: true, reminderMinutesBefore: 15, category: 'Kaam',
    });
    setShowModal(true);
  };

  const openEdit = (task: Task) => {
    setEditingTask(task);
    setForm({
      title: task.title,
      description: task.description || '',
      priority: task.priority,
      dueDate: task.dueDate.split('T')[0],
      dueTime: task.dueTime || '',
      reminderEnabled: task.reminderEnabled,
      reminderMinutesBefore: task.reminderMinutesBefore,
      category: task.category,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.title.trim()) {
      Alert.alert('Error', 'Task ka naam dalo!');
      return;
    }

    if (editingTask) {
      const updated: Partial<Task> = { ...form, dueDate: form.dueDate };
      await updateTask(editingTask.id, updated);
    } else {
      const newTask: Task = {
        id: generateId(),
        ...form,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      await addTask(newTask);
      if (newTask.reminderEnabled) {
        await NotificationService.scheduleTaskReminder(newTask);
      }
    }
    setShowModal(false);
  };

  const toggleStatus = async (task: Task) => {
    const newStatus = task.status === 'completed' ? 'pending' : 'completed';
    await updateTask(task.id, {
      status: newStatus,
      completedAt: newStatus === 'completed' ? new Date().toISOString() : undefined,
    });
  };

  const handleDelete = (task: Task) => {
    Alert.alert(
      'Task Delete',
      `"${task.title}" delete karna chahte ho?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteTask(task.id) },
      ]
    );
  };

  const priorityColor = (p: Priority) =>
    p === 'high' ? '#f44336' : p === 'medium' ? '#ff9800' : '#4caf50';

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f23" />

      <View style={styles.header}>
        <Text style={styles.title}>Tasks</Text>
        <TouchableOpacity style={styles.addBtn} onPress={openAdd}>
          <Ionicons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Filter tabs */}
      <View style={styles.filterRow}>
        {(['all', 'pending', 'completed'] as const).map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterTab, filter === f && styles.filterTabActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f === 'all' ? 'Sab' : f === 'pending' ? 'Pending' : 'Done'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filteredTasks}
        keyExtractor={t => t.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="clipboard-outline" size={60} color="#333" />
            <Text style={styles.emptyText}>Koi task nahi</Text>
            <TouchableOpacity style={styles.emptyAddBtn} onPress={openAdd}>
              <Text style={styles.emptyAddText}>+ Task Add Karo</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item: task }) => (
          <TouchableOpacity style={styles.taskCard} onLongPress={() => openEdit(task)}>
            <TouchableOpacity style={styles.checkbox} onPress={() => toggleStatus(task)}>
              <Ionicons
                name={task.status === 'completed' ? 'checkmark-circle' : 'ellipse-outline'}
                size={26}
                color={task.status === 'completed' ? '#4caf50' : '#555'}
              />
            </TouchableOpacity>
            <View style={styles.taskBody}>
              <View style={styles.taskTitleRow}>
                <Text style={[styles.taskTitle, task.status === 'completed' && styles.taskDone]}>
                  {task.title}
                </Text>
                <View style={[styles.priorityBadge, { backgroundColor: priorityColor(task.priority) + '33' }]}>
                  <Text style={[styles.priorityText, { color: priorityColor(task.priority) }]}>
                    {task.priority.toUpperCase()}
                  </Text>
                </View>
              </View>
              {task.description ? (
                <Text style={styles.taskDesc} numberOfLines={1}>{task.description}</Text>
              ) : null}
              <View style={styles.taskMeta}>
                <Ionicons name="calendar-outline" size={12} color="#888" />
                <Text style={styles.taskMetaText}>
                  {format(new Date(task.dueDate), 'dd MMM')}
                  {task.dueTime ? ` • ${task.dueTime}` : ''}
                </Text>
                <View style={styles.categoryBadge}>
                  <Text style={styles.categoryText}>{task.category}</Text>
                </View>
              </View>
            </View>
            <TouchableOpacity onPress={() => handleDelete(task)} style={styles.deleteBtn}>
              <Ionicons name="trash-outline" size={18} color="#f44336" />
            </TouchableOpacity>
          </TouchableOpacity>
        )}
      />

      {/* Add/Edit Modal */}
      <Modal visible={showModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editingTask ? 'Task Edit Karo' : 'Naya Task'}
              </Text>
              <TouchableOpacity onPress={() => setShowModal(false)}>
                <Ionicons name="close" size={24} color="#888" />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.label}>Task Ka Naam *</Text>
              <TextInput
                style={styles.input}
                value={form.title}
                onChangeText={v => setForm(f => ({ ...f, title: v }))}
                placeholder="Task ka naam likho..."
                placeholderTextColor="#555"
              />

              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={form.description}
                onChangeText={v => setForm(f => ({ ...f, description: v }))}
                placeholder="Details..."
                placeholderTextColor="#555"
                multiline
                numberOfLines={3}
              />

              <Text style={styles.label}>Priority</Text>
              <View style={styles.optionRow}>
                {PRIORITIES.map(p => (
                  <TouchableOpacity
                    key={p.value}
                    style={[styles.optionBtn, form.priority === p.value && { backgroundColor: p.color + '33', borderColor: p.color }]}
                    onPress={() => setForm(f => ({ ...f, priority: p.value }))}
                  >
                    <Text style={[styles.optionText, form.priority === p.value && { color: p.color }]}>
                      {p.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.optionRow}>
                  {CATEGORIES.map(c => (
                    <TouchableOpacity
                      key={c}
                      style={[styles.optionBtn, form.category === c && styles.optionBtnActive]}
                      onPress={() => setForm(f => ({ ...f, category: c }))}
                    >
                      <Text style={[styles.optionText, form.category === c && styles.optionTextActive]}>{c}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>

              <Text style={styles.label}>Due Date (yyyy-mm-dd)</Text>
              <TextInput
                style={styles.input}
                value={form.dueDate}
                onChangeText={v => setForm(f => ({ ...f, dueDate: v }))}
                placeholder="2025-12-31"
                placeholderTextColor="#555"
              />

              <Text style={styles.label}>Due Time (HH:MM)</Text>
              <TextInput
                style={styles.input}
                value={form.dueTime}
                onChangeText={v => setForm(f => ({ ...f, dueTime: v }))}
                placeholder="14:30"
                placeholderTextColor="#555"
              />

              <View style={styles.switchRow}>
                <Text style={styles.label}>Reminder</Text>
                <TouchableOpacity
                  style={[styles.toggle, form.reminderEnabled && styles.toggleOn]}
                  onPress={() => setForm(f => ({ ...f, reminderEnabled: !f.reminderEnabled }))}
                >
                  <View style={[styles.toggleThumb, form.reminderEnabled && styles.toggleThumbOn]} />
                </TouchableOpacity>
              </View>

              {form.reminderEnabled && (
                <>
                  <Text style={styles.label}>Kitne minute pehle reminder?</Text>
                  <View style={styles.optionRow}>
                    {[5, 10, 15, 30, 60].map(m => (
                      <TouchableOpacity
                        key={m}
                        style={[styles.optionBtn, form.reminderMinutesBefore === m && styles.optionBtnActive]}
                        onPress={() => setForm(f => ({ ...f, reminderMinutesBefore: m }))}
                      >
                        <Text style={[styles.optionText, form.reminderMinutesBefore === m && styles.optionTextActive]}>
                          {m}m
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                <Text style={styles.saveBtnText}>
                  {editingTask ? 'Update Karo' : 'Add Karo'}
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
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 20, paddingTop: 50,
  },
  title: { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  addBtn: { backgroundColor: '#7c4dff', width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  filterRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 10, marginBottom: 16 },
  filterTab: { flex: 1, paddingVertical: 8, borderRadius: 20, backgroundColor: '#1a1a35', alignItems: 'center' },
  filterTabActive: { backgroundColor: '#7c4dff' },
  filterText: { color: '#888', fontWeight: '500' },
  filterTextActive: { color: '#fff' },
  list: { padding: 16, gap: 12, paddingBottom: 100 },
  empty: { alignItems: 'center', marginTop: 80, gap: 16 },
  emptyText: { color: '#555', fontSize: 16 },
  emptyAddBtn: { backgroundColor: '#7c4dff', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 25 },
  emptyAddText: { color: '#fff', fontWeight: '600' },
  taskCard: {
    backgroundColor: '#1a1a35', borderRadius: 14, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  checkbox: { padding: 2 },
  taskBody: { flex: 1 },
  taskTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  taskTitle: { color: '#e0e0e0', fontSize: 15, fontWeight: '600', flex: 1 },
  taskDone: { textDecorationLine: 'line-through', color: '#555' },
  priorityBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  priorityText: { fontSize: 10, fontWeight: '700' },
  taskDesc: { color: '#888', fontSize: 13, marginTop: 3 },
  taskMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  taskMetaText: { color: '#888', fontSize: 12, marginRight: 8 },
  categoryBadge: { backgroundColor: '#2a2a4a', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  categoryText: { color: '#888', fontSize: 11 },
  deleteBtn: { padding: 6 },
  modalOverlay: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#1a1a35', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff' },
  label: { color: '#aaa', fontSize: 13, marginBottom: 6, marginTop: 14 },
  input: { backgroundColor: '#0f0f23', borderRadius: 10, padding: 12, color: '#fff', fontSize: 15, borderWidth: 1, borderColor: '#2a2a4a' },
  textArea: { height: 80, textAlignVertical: 'top' },
  optionRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  optionBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#0f0f23', borderWidth: 1, borderColor: '#333' },
  optionBtnActive: { backgroundColor: '#7c4dff33', borderColor: '#7c4dff' },
  optionText: { color: '#888', fontWeight: '500' },
  optionTextActive: { color: '#7c4dff' },
  switchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: '#333', justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: '#7c4dff' },
  toggleThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  toggleThumbOn: { alignSelf: 'flex-end' },
  saveBtn: { backgroundColor: '#7c4dff', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24, marginBottom: 10 },
  saveBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
});
