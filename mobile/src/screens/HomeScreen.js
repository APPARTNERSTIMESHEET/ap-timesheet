import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS } from '../theme';
import { getTasks, getReminders, getTargets } from '../storage/storage';

export default function HomeScreen({ navigation }) {
  const [tasks, setTasks] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [targets, setTargets] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [t, r, g] = await Promise.all([getTasks(), getReminders(), getTargets()]);
    const today = new Date().toDateString();
    setTasks(t.filter(x => !x.completed && new Date(x.dueDate).toDateString() === today));
    setReminders(r.filter(x => new Date(x.scheduledTime) > new Date()).slice(0, 3));
    setTargets(g.filter(x => !x.completed).slice(0, 3));
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const now = new Date();
  const greeting = now.getHours() < 12 ? 'Good Morning' : now.getHours() < 17 ? 'Good Afternoon' : 'Good Evening';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>{greeting} 👋</Text>
          <Text style={styles.date}>
            {now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </Text>
        </View>
        <TouchableOpacity style={styles.focusBtn} onPress={() => navigation.navigate('Focus')}>
          <Ionicons name="lock-closed" size={20} color={COLORS.text} />
          <Text style={styles.focusBtnText}>Focus</Text>
        </TouchableOpacity>
      </View>

      {/* Stats Row */}
      <View style={styles.statsRow}>
        <StatCard icon="checkmark-circle" label="Today's Tasks" value={tasks.length} color={COLORS.accent} />
        <StatCard icon="alarm" label="Reminders" value={reminders.length} color={COLORS.primary} />
        <StatCard icon="trophy" label="Targets" value={targets.length} color={COLORS.warning} />
      </View>

      {/* Today's Tasks */}
      <SectionHeader title="Today's Tasks" onAdd={() => navigation.navigate('AddTask', {})} />
      {tasks.length === 0 ? (
        <EmptyCard icon="checkmark-done-circle-outline" text="No tasks for today. Add one!" />
      ) : (
        tasks.slice(0, 4).map(task => (
          <TaskRow key={task.id} task={task} />
        ))
      )}
      {tasks.length > 4 && (
        <TouchableOpacity onPress={() => navigation.navigate('Tasks')}>
          <Text style={styles.seeAll}>See all {tasks.length} tasks →</Text>
        </TouchableOpacity>
      )}

      {/* Upcoming Reminders */}
      <SectionHeader title="Upcoming Reminders" onAdd={() => navigation.navigate('AddReminder', {})} />
      {reminders.length === 0 ? (
        <EmptyCard icon="alarm-outline" text="No upcoming reminders." />
      ) : (
        reminders.map(r => <ReminderRow key={r.id} reminder={r} />)
      )}

      {/* Active Targets */}
      <SectionHeader title="Active Targets" onAdd={() => navigation.navigate('AddTarget', {})} />
      {targets.length === 0 ? (
        <EmptyCard icon="trophy-outline" text="Set a target to stay motivated!" />
      ) : (
        targets.map(t => <TargetRow key={t.id} target={t} onFocus={() => navigation.navigate('Focus', { targetId: t.id })} />)
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

function StatCard({ icon, label, value, color }) {
  return (
    <View style={[styles.statCard, { borderTopColor: color }]}>
      <Ionicons name={icon} size={22} color={color} />
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function SectionHeader({ title, onAdd }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <TouchableOpacity onPress={onAdd} style={styles.addBtn}>
        <Ionicons name="add" size={20} color={COLORS.primary} />
      </TouchableOpacity>
    </View>
  );
}

function EmptyCard({ icon, text }) {
  return (
    <View style={styles.emptyCard}>
      <Ionicons name={icon} size={32} color={COLORS.textMuted} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function TaskRow({ task }) {
  const priorityColors = { high: COLORS.danger, medium: COLORS.warning, low: COLORS.accent };
  return (
    <View style={styles.taskRow}>
      <View style={[styles.priorityDot, { backgroundColor: priorityColors[task.priority] || COLORS.primary }]} />
      <Text style={styles.taskTitle} numberOfLines={1}>{task.title}</Text>
      {task.dueTime && <Text style={styles.taskTime}>{task.dueTime}</Text>}
    </View>
  );
}

function ReminderRow({ reminder }) {
  const t = new Date(reminder.scheduledTime);
  return (
    <View style={styles.reminderRow}>
      <Ionicons name={reminder.callNumber ? 'call' : 'alarm'} size={18} color={COLORS.primary} />
      <View style={styles.reminderInfo}>
        <Text style={styles.reminderTitle} numberOfLines={1}>{reminder.title}</Text>
        {reminder.callNumber && <Text style={styles.reminderPhone}>{reminder.callNumber}</Text>}
      </View>
      <Text style={styles.reminderTime}>
        {t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
      </Text>
    </View>
  );
}

function TargetRow({ target, onFocus }) {
  const deadline = new Date(target.deadline);
  const daysLeft = Math.ceil((deadline - new Date()) / (1000 * 60 * 60 * 24));
  return (
    <View style={styles.targetRow}>
      <View style={styles.targetInfo}>
        <Text style={styles.targetTitle} numberOfLines={1}>{target.title}</Text>
        <Text style={styles.targetDeadline}>
          {daysLeft > 0 ? `${daysLeft} days left` : daysLeft === 0 ? 'Due today!' : 'Overdue'}
        </Text>
      </View>
      <TouchableOpacity style={styles.focusIconBtn} onPress={onFocus}>
        <Ionicons name="lock-closed-outline" size={18} color={COLORS.primary} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.lg, marginTop: SPACING.sm },
  greeting: { fontSize: 22, fontWeight: '700', color: COLORS.text },
  date: { fontSize: 13, color: COLORS.textSecondary, marginTop: 2 },
  focusBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.secondary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.round, gap: 6 },
  focusBtnText: { color: COLORS.text, fontWeight: '600', fontSize: 14 },
  statsRow: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.lg },
  statCard: { flex: 1, backgroundColor: COLORS.card, borderRadius: RADIUS.md, padding: SPACING.sm, alignItems: 'center', borderTopWidth: 3 },
  statValue: { fontSize: 24, fontWeight: '800', color: COLORS.text, marginTop: 4 },
  statLabel: { fontSize: 11, color: COLORS.textSecondary, marginTop: 2, textAlign: 'center' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.sm, marginTop: SPACING.lg },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  addBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.cardLight, alignItems: 'center', justifyContent: 'center' },
  emptyCard: { backgroundColor: COLORS.surface, borderRadius: RADIUS.md, padding: SPACING.lg, alignItems: 'center', gap: 8 },
  emptyText: { color: COLORS.textMuted, fontSize: 14 },
  taskRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.xs, gap: 10 },
  priorityDot: { width: 8, height: 8, borderRadius: 4 },
  taskTitle: { flex: 1, color: COLORS.text, fontSize: 14, fontWeight: '500' },
  taskTime: { color: COLORS.textSecondary, fontSize: 12 },
  reminderRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.xs, gap: 10 },
  reminderInfo: { flex: 1 },
  reminderTitle: { color: COLORS.text, fontSize: 14, fontWeight: '500' },
  reminderPhone: { color: COLORS.primary, fontSize: 12, marginTop: 2 },
  reminderTime: { color: COLORS.warning, fontSize: 13, fontWeight: '600' },
  targetRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.card, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.xs },
  targetInfo: { flex: 1 },
  targetTitle: { color: COLORS.text, fontSize: 14, fontWeight: '500' },
  targetDeadline: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  focusIconBtn: { padding: 6 },
  seeAll: { color: COLORS.primary, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: SPACING.sm },
});
