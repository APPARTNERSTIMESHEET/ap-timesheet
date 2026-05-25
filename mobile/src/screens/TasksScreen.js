import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS } from '../theme';
import { getTasks, updateTask, deleteTask } from '../storage/storage';

const FILTERS = ['All', 'Today', 'Pending', 'Completed'];
const PRIORITY_COLORS = { high: COLORS.danger, medium: COLORS.warning, low: COLORS.accent };

export default function TasksScreen({ navigation }) {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('All');

  const load = useCallback(async () => {
    setTasks(await getTasks());
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = tasks.filter(t => {
    const today = new Date().toDateString();
    if (filter === 'Today') return new Date(t.dueDate).toDateString() === today;
    if (filter === 'Pending') return !t.completed;
    if (filter === 'Completed') return t.completed;
    return true;
  });

  const toggle = async (task) => {
    await updateTask(task.id, { completed: !task.completed });
    load();
  };

  const remove = (task) => {
    Alert.alert('Delete Task', `Delete "${task.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteTask(task.id); load(); } },
    ]);
  };

  return (
    <View style={styles.container}>
      {/* Filter chips */}
      <View style={styles.filters}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.chip, filter === f && styles.chipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={i => i.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            onToggle={() => toggle(item)}
            onEdit={() => navigation.navigate('AddTask', { task: item })}
            onDelete={() => remove(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="clipboard-outline" size={48} color={COLORS.textMuted} />
            <Text style={styles.emptyText}>No tasks found</Text>
          </View>
        }
      />

      <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('AddTask', {})}>
        <Ionicons name="add" size={28} color={COLORS.text} />
      </TouchableOpacity>
    </View>
  );
}

function TaskCard({ task, onToggle, onEdit, onDelete }) {
  const due = new Date(task.dueDate);
  const isOverdue = !task.completed && due < new Date() && due.toDateString() !== new Date().toDateString();

  return (
    <View style={[styles.card, task.completed && styles.cardDone, isOverdue && styles.cardOverdue]}>
      <TouchableOpacity onPress={onToggle} style={styles.checkbox}>
        <Ionicons
          name={task.completed ? 'checkmark-circle' : 'ellipse-outline'}
          size={24}
          color={task.completed ? COLORS.success : COLORS.border}
        />
      </TouchableOpacity>
      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Text style={[styles.cardTitle, task.completed && styles.cardTitleDone]} numberOfLines={2}>
            {task.title}
          </Text>
          <View style={[styles.priorityBadge, { backgroundColor: PRIORITY_COLORS[task.priority] + '33' }]}>
            <Text style={[styles.priorityText, { color: PRIORITY_COLORS[task.priority] }]}>
              {task.priority}
            </Text>
          </View>
        </View>
        {task.description ? (
          <Text style={styles.cardDesc} numberOfLines={1}>{task.description}</Text>
        ) : null}
        <View style={styles.cardMeta}>
          <Ionicons name="calendar-outline" size={13} color={COLORS.textMuted} />
          <Text style={[styles.metaText, isOverdue && styles.overdueText]}>
            {due.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            {task.dueTime ? ` · ${task.dueTime}` : ''}
          </Text>
          {isOverdue && <Text style={styles.overdueTag}>Overdue</Text>}
        </View>
      </View>
      <View style={styles.cardActions}>
        <TouchableOpacity onPress={onEdit} style={styles.actionBtn}>
          <Ionicons name="pencil-outline" size={18} color={COLORS.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onDelete} style={styles.actionBtn}>
          <Ionicons name="trash-outline" size={18} color={COLORS.danger} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  filters: { flexDirection: 'row', padding: SPACING.md, gap: SPACING.sm },
  chip: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: RADIUS.round, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '500' },
  chipTextActive: { color: COLORS.text },
  list: { padding: SPACING.md, paddingTop: 0, paddingBottom: 100 },
  card: { backgroundColor: COLORS.card, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.sm, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardDone: { opacity: 0.55 },
  cardOverdue: { borderLeftWidth: 3, borderLeftColor: COLORS.danger },
  checkbox: { paddingTop: 1 },
  cardBody: { flex: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  cardTitle: { flex: 1, color: COLORS.text, fontSize: 15, fontWeight: '600' },
  cardTitleDone: { textDecorationLine: 'line-through', color: COLORS.textMuted },
  priorityBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: RADIUS.round },
  priorityText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  cardDesc: { color: COLORS.textSecondary, fontSize: 13, marginBottom: 6 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { color: COLORS.textMuted, fontSize: 12 },
  overdueText: { color: COLORS.danger },
  overdueTag: { color: COLORS.danger, fontSize: 11, fontWeight: '700', marginLeft: 4 },
  cardActions: { gap: 6 },
  actionBtn: { padding: 4 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  emptyText: { color: COLORS.textMuted, fontSize: 16 },
  fab: { position: 'absolute', bottom: 24, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', elevation: 8, shadowColor: COLORS.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8 },
});
