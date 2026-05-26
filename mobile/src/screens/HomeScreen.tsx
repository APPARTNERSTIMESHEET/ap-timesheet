import React, { useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, Dimensions,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { useAppStore } from '../store/appStore';

const { width } = Dimensions.get('window');

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const { tasks, targets, callSchedules, intruderRecords, activeFocusSession, loadAll, isLoaded } =
    useAppStore();

  useEffect(() => {
    if (!isLoaded) loadAll();
  }, []);

  const todayTasks = tasks.filter(t => {
    const due = new Date(t.dueDate);
    const today = new Date();
    return (
      due.getFullYear() === today.getFullYear() &&
      due.getMonth() === today.getMonth() &&
      due.getDate() === today.getDate()
    );
  });

  const pendingTasks = todayTasks.filter(t => t.status !== 'completed').length;
  const completedTasks = todayTasks.filter(t => t.status === 'completed').length;
  const upcomingCalls = callSchedules.filter(
    c => !c.isCompleted && new Date(c.scheduledAt) > new Date()
  ).length;

  const nextCall = callSchedules
    .filter(c => !c.isCompleted && new Date(c.scheduledAt) > new Date())
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())[0];

  const activeTargets = targets.filter(t => new Date(t.deadline) > new Date()).length;

  const stats = [
    { label: 'Aaj Ke Tasks', value: pendingTasks, icon: 'checkbox-outline', color: '#4caf50', screen: 'Tasks' },
    { label: 'Targets Active', value: activeTargets, icon: 'flag-outline', color: '#ff9800', screen: 'Targets' },
    { label: 'Scheduled Calls', value: upcomingCalls, icon: 'call-outline', color: '#2196f3', screen: 'Calls' },
    { label: 'Intruder Alerts', value: intruderRecords.length, icon: 'shield-outline', color: '#f44336', screen: 'Security' },
  ];

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0f0f23" />
      <ScrollView showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>Namaste!</Text>
            <Text style={styles.dateText}>{format(new Date(), 'EEEE, dd MMMM yyyy')}</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={styles.settingsBtn}>
            <Ionicons name="settings-outline" size={24} color="#e0e0e0" />
          </TouchableOpacity>
        </View>

        {/* Active Focus Session Banner */}
        {activeFocusSession && (
          <TouchableOpacity
            style={styles.focusBanner}
            onPress={() => navigation.navigate('Focus')}
          >
            <Ionicons name="lock-closed" size={20} color="#fff" />
            <Text style={styles.focusBannerText}>
              Focus Mode Active: {activeFocusSession.title}
            </Text>
            <Text style={styles.focusBannerSub}>
              Ends: {format(new Date(activeFocusSession.endsAt), 'hh:mm a')}
            </Text>
          </TouchableOpacity>
        )}

        {/* Stats Grid */}
        <View style={styles.statsGrid}>
          {stats.map((stat) => (
            <TouchableOpacity
              key={stat.label}
              style={styles.statCard}
              onPress={() => navigation.navigate(stat.screen)}
            >
              <View style={[styles.statIcon, { backgroundColor: stat.color + '22' }]}>
                <Ionicons name={stat.icon as any} size={24} color={stat.color} />
              </View>
              <Text style={styles.statValue}>{stat.value}</Text>
              <Text style={styles.statLabel}>{stat.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Today's Tasks */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Aaj Ke Tasks</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Tasks')}>
              <Text style={styles.seeAll}>Sab Dekho</Text>
            </TouchableOpacity>
          </View>
          {todayTasks.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="checkmark-circle-outline" size={40} color="#555" />
              <Text style={styles.emptyText}>Aaj koi task nahi</Text>
              <TouchableOpacity
                style={styles.addBtn}
                onPress={() => navigation.navigate('Tasks', { openAdd: true })}
              >
                <Text style={styles.addBtnText}>+ Task Add Karo</Text>
              </TouchableOpacity>
            </View>
          ) : (
            todayTasks.slice(0, 3).map(task => (
              <TouchableOpacity
                key={task.id}
                style={styles.taskItem}
                onPress={() => navigation.navigate('Tasks')}
              >
                <View style={[styles.taskDot, {
                  backgroundColor: task.status === 'completed' ? '#4caf50' :
                    task.priority === 'high' ? '#f44336' :
                      task.priority === 'medium' ? '#ff9800' : '#4caf50'
                }]} />
                <View style={styles.taskInfo}>
                  <Text style={[styles.taskTitle, task.status === 'completed' && styles.taskDone]}>
                    {task.title}
                  </Text>
                  {task.dueTime && (
                    <Text style={styles.taskTime}>{task.dueTime}</Text>
                  )}
                </View>
                {task.status === 'completed' && (
                  <Ionicons name="checkmark-circle" size={20} color="#4caf50" />
                )}
              </TouchableOpacity>
            ))
          )}
          {todayTasks.length > 3 && (
            <TouchableOpacity onPress={() => navigation.navigate('Tasks')}>
              <Text style={styles.moreText}>+{todayTasks.length - 3} aur tasks...</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Next Call */}
        {nextCall && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Agle Call</Text>
            <TouchableOpacity
              style={styles.callCard}
              onPress={() => navigation.navigate('Calls')}
            >
              <View style={styles.callIcon}>
                <Ionicons name="call" size={24} color="#fff" />
              </View>
              <View style={styles.callInfo}>
                <Text style={styles.callName}>{nextCall.contactName}</Text>
                <Text style={styles.callNumber}>{nextCall.contactPhone}</Text>
                <Text style={styles.callTime}>
                  {format(new Date(nextCall.scheduledAt), 'dd MMM, hh:mm a')}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color="#888" />
            </TouchableOpacity>
          </View>
        )}

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.quickActions}>
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => navigation.navigate('Tasks', { openAdd: true })}
            >
              <Ionicons name="add-circle" size={28} color="#4caf50" />
              <Text style={styles.quickBtnText}>Task</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => navigation.navigate('Focus')}
            >
              <Ionicons name="lock-closed" size={28} color="#9c27b0" />
              <Text style={styles.quickBtnText}>Focus</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => navigation.navigate('Calls', { openAdd: true })}
            >
              <Ionicons name="call" size={28} color="#2196f3" />
              <Text style={styles.quickBtnText}>Call</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickBtn}
              onPress={() => navigation.navigate('Targets', { openAdd: true })}
            >
              <Ionicons name="flag" size={28} color="#ff9800" />
              <Text style={styles.quickBtnText}>Target</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f23' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 20, paddingTop: 50,
  },
  greeting: { fontSize: 26, fontWeight: 'bold', color: '#fff' },
  dateText: { fontSize: 13, color: '#888', marginTop: 2 },
  settingsBtn: { padding: 8 },
  focusBanner: {
    margin: 16, padding: 14, backgroundColor: '#9c27b0', borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  focusBannerText: { color: '#fff', fontWeight: '600', flex: 1 },
  focusBannerSub: { color: '#e1bee7', fontSize: 12 },
  statsGrid: {
    flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, gap: 12,
    paddingBottom: 8,
  },
  statCard: {
    backgroundColor: '#1a1a35', borderRadius: 14, padding: 16,
    width: (width - 48) / 2, alignItems: 'center', gap: 8,
  },
  statIcon: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  statValue: { fontSize: 28, fontWeight: 'bold', color: '#fff' },
  statLabel: { fontSize: 12, color: '#888', textAlign: 'center' },
  section: { paddingHorizontal: 16, marginTop: 20 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 12 },
  seeAll: { color: '#7c4dff', fontSize: 13 },
  emptyCard: {
    backgroundColor: '#1a1a35', borderRadius: 14, padding: 30,
    alignItems: 'center', gap: 10,
  },
  emptyText: { color: '#666', fontSize: 14 },
  addBtn: { backgroundColor: '#7c4dff', paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20, marginTop: 8 },
  addBtnText: { color: '#fff', fontWeight: '600' },
  taskItem: {
    backgroundColor: '#1a1a35', borderRadius: 10, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8,
  },
  taskDot: { width: 10, height: 10, borderRadius: 5 },
  taskInfo: { flex: 1 },
  taskTitle: { color: '#e0e0e0', fontSize: 15, fontWeight: '500' },
  taskDone: { textDecorationLine: 'line-through', color: '#555' },
  taskTime: { color: '#888', fontSize: 12, marginTop: 2 },
  moreText: { color: '#7c4dff', textAlign: 'center', marginTop: 8, fontSize: 13 },
  callCard: {
    backgroundColor: '#1a1a35', borderRadius: 14, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  callIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#2196f3', alignItems: 'center', justifyContent: 'center' },
  callInfo: { flex: 1 },
  callName: { color: '#fff', fontWeight: '600', fontSize: 16 },
  callNumber: { color: '#888', fontSize: 13, marginTop: 2 },
  callTime: { color: '#2196f3', fontSize: 12, marginTop: 2 },
  quickActions: {
    flexDirection: 'row', justifyContent: 'space-around',
    backgroundColor: '#1a1a35', borderRadius: 14, padding: 16,
  },
  quickBtn: { alignItems: 'center', gap: 6 },
  quickBtnText: { color: '#888', fontSize: 12 },
});
