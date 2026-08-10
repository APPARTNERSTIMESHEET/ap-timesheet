import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Task, Target, CallSchedule, FocusSession, IntruderRecord, AppSettings } from '../types';

const STORAGE_KEYS = {
  TASKS: '@ap_focuslock_tasks',
  TARGETS: '@ap_focuslock_targets',
  CALLS: '@ap_focuslock_calls',
  SESSIONS: '@ap_focuslock_sessions',
  INTRUDERS: '@ap_focuslock_intruders',
  SETTINGS: '@ap_focuslock_settings',
};

const DEFAULT_SETTINGS: AppSettings = {
  intruderDetectionEnabled: true,
  intruderMaxAttempts: 3,
  focusLockStrict: false,
  defaultReminderMinutes: 15,
  theme: 'dark',
};

interface AppState {
  tasks: Task[];
  targets: Target[];
  callSchedules: CallSchedule[];
  focusSessions: FocusSession[];
  intruderRecords: IntruderRecord[];
  settings: AppSettings;
  activeFocusSession: FocusSession | null;
  isLoaded: boolean;

  // Actions
  loadAll: () => Promise<void>;
  addTask: (task: Task) => Promise<void>;
  updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addTarget: (target: Target) => Promise<void>;
  updateTarget: (id: string, updates: Partial<Target>) => Promise<void>;
  deleteTarget: (id: string) => Promise<void>;
  addCallSchedule: (call: CallSchedule) => Promise<void>;
  updateCallSchedule: (id: string, updates: Partial<CallSchedule>) => Promise<void>;
  deleteCallSchedule: (id: string) => Promise<void>;
  startFocusSession: (session: FocusSession) => Promise<void>;
  endFocusSession: () => Promise<void>;
  addIntruderRecord: (record: IntruderRecord) => Promise<void>;
  clearIntruderRecords: () => Promise<void>;
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  tasks: [],
  targets: [],
  callSchedules: [],
  focusSessions: [],
  intruderRecords: [],
  settings: DEFAULT_SETTINGS,
  activeFocusSession: null,
  isLoaded: false,

  loadAll: async () => {
    try {
      const [tasks, targets, calls, sessions, intruders, settings] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.TASKS),
        AsyncStorage.getItem(STORAGE_KEYS.TARGETS),
        AsyncStorage.getItem(STORAGE_KEYS.CALLS),
        AsyncStorage.getItem(STORAGE_KEYS.SESSIONS),
        AsyncStorage.getItem(STORAGE_KEYS.INTRUDERS),
        AsyncStorage.getItem(STORAGE_KEYS.SETTINGS),
      ]);

      const parsedSessions: FocusSession[] = sessions ? JSON.parse(sessions) : [];
      const activeSession = parsedSessions.find(
        s => s.isActive && new Date(s.endsAt) > new Date()
      ) || null;

      set({
        tasks: tasks ? JSON.parse(tasks) : [],
        targets: targets ? JSON.parse(targets) : [],
        callSchedules: calls ? JSON.parse(calls) : [],
        focusSessions: parsedSessions,
        intruderRecords: intruders ? JSON.parse(intruders) : [],
        settings: settings ? { ...DEFAULT_SETTINGS, ...JSON.parse(settings) } : DEFAULT_SETTINGS,
        activeFocusSession: activeSession,
        isLoaded: true,
      });
    } catch {
      set({ isLoaded: true });
    }
  },

  addTask: async (task) => {
    const tasks = [...get().tasks, task];
    set({ tasks });
    await AsyncStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(tasks));
  },

  updateTask: async (id, updates) => {
    const tasks = get().tasks.map(t => t.id === id ? { ...t, ...updates } : t);
    set({ tasks });
    await AsyncStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(tasks));
  },

  deleteTask: async (id) => {
    const tasks = get().tasks.filter(t => t.id !== id);
    set({ tasks });
    await AsyncStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(tasks));
  },

  addTarget: async (target) => {
    const targets = [...get().targets, target];
    set({ targets });
    await AsyncStorage.setItem(STORAGE_KEYS.TARGETS, JSON.stringify(targets));
  },

  updateTarget: async (id, updates) => {
    const targets = get().targets.map(t => t.id === id ? { ...t, ...updates } : t);
    set({ targets });
    await AsyncStorage.setItem(STORAGE_KEYS.TARGETS, JSON.stringify(targets));
  },

  deleteTarget: async (id) => {
    const targets = get().targets.filter(t => t.id !== id);
    set({ targets });
    await AsyncStorage.setItem(STORAGE_KEYS.TARGETS, JSON.stringify(targets));
  },

  addCallSchedule: async (call) => {
    const callSchedules = [...get().callSchedules, call];
    set({ callSchedules });
    await AsyncStorage.setItem(STORAGE_KEYS.CALLS, JSON.stringify(callSchedules));
  },

  updateCallSchedule: async (id, updates) => {
    const callSchedules = get().callSchedules.map(c => c.id === id ? { ...c, ...updates } : c);
    set({ callSchedules });
    await AsyncStorage.setItem(STORAGE_KEYS.CALLS, JSON.stringify(callSchedules));
  },

  deleteCallSchedule: async (id) => {
    const callSchedules = get().callSchedules.filter(c => c.id !== id);
    set({ callSchedules });
    await AsyncStorage.setItem(STORAGE_KEYS.CALLS, JSON.stringify(callSchedules));
  },

  startFocusSession: async (session) => {
    const focusSessions = [...get().focusSessions, session];
    set({ focusSessions, activeFocusSession: session });
    await AsyncStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(focusSessions));
  },

  endFocusSession: async () => {
    const active = get().activeFocusSession;
    if (!active) return;
    const focusSessions = get().focusSessions.map(s =>
      s.id === active.id ? { ...s, isActive: false } : s
    );
    set({ focusSessions, activeFocusSession: null });
    await AsyncStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(focusSessions));
  },

  addIntruderRecord: async (record) => {
    const intruderRecords = [...get().intruderRecords, record];
    set({ intruderRecords });
    await AsyncStorage.setItem(STORAGE_KEYS.INTRUDERS, JSON.stringify(intruderRecords));
  },

  clearIntruderRecords: async () => {
    set({ intruderRecords: [] });
    await AsyncStorage.setItem(STORAGE_KEYS.INTRUDERS, JSON.stringify([]));
  },

  updateSettings: async (updates) => {
    const settings = { ...get().settings, ...updates };
    set({ settings });
    await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  },
}));
