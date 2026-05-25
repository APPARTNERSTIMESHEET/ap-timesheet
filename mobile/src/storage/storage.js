import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  TASKS: '@tasks',
  REMINDERS: '@reminders',
  TARGETS: '@targets',
  FOCUS_SESSION: '@focus_session',
};

// ── Tasks ──────────────────────────────────────────────────
export async function getTasks() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.TASKS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveTasks(tasks) {
  await AsyncStorage.setItem(KEYS.TASKS, JSON.stringify(tasks));
}

export async function addTask(task) {
  const tasks = await getTasks();
  tasks.unshift(task);
  await saveTasks(tasks);
}

export async function updateTask(id, updates) {
  const tasks = await getTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx !== -1) {
    tasks[idx] = { ...tasks[idx], ...updates };
    await saveTasks(tasks);
  }
}

export async function deleteTask(id) {
  const tasks = await getTasks();
  await saveTasks(tasks.filter(t => t.id !== id));
}

// ── Reminders ──────────────────────────────────────────────
export async function getReminders() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.REMINDERS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveReminders(reminders) {
  await AsyncStorage.setItem(KEYS.REMINDERS, JSON.stringify(reminders));
}

export async function addReminder(reminder) {
  const reminders = await getReminders();
  reminders.unshift(reminder);
  await saveReminders(reminders);
}

export async function updateReminder(id, updates) {
  const reminders = await getReminders();
  const idx = reminders.findIndex(r => r.id === id);
  if (idx !== -1) {
    reminders[idx] = { ...reminders[idx], ...updates };
    await saveReminders(reminders);
  }
}

export async function deleteReminder(id) {
  const reminders = await getReminders();
  await saveReminders(reminders.filter(r => r.id !== id));
}

// ── Targets ────────────────────────────────────────────────
export async function getTargets() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.TARGETS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveTargets(targets) {
  await AsyncStorage.setItem(KEYS.TARGETS, JSON.stringify(targets));
}

export async function addTarget(target) {
  const targets = await getTargets();
  targets.unshift(target);
  await saveTargets(targets);
}

export async function updateTarget(id, updates) {
  const targets = await getTargets();
  const idx = targets.findIndex(t => t.id === id);
  if (idx !== -1) {
    targets[idx] = { ...targets[idx], ...updates };
    await saveTargets(targets);
  }
}

export async function deleteTarget(id) {
  const targets = await getTargets();
  await saveTargets(targets.filter(t => t.id !== id));
}

// ── Focus Session ──────────────────────────────────────────
export async function getFocusSession() {
  try {
    const raw = await AsyncStorage.getItem(KEYS.FOCUS_SESSION);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setFocusSession(session) {
  if (session) {
    await AsyncStorage.setItem(KEYS.FOCUS_SESSION, JSON.stringify(session));
  } else {
    await AsyncStorage.removeItem(KEYS.FOCUS_SESSION);
  }
}
