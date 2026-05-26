export type Priority = 'high' | 'medium' | 'low';
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  status: TaskStatus;
  dueDate: string; // ISO string
  dueTime?: string; // HH:MM format
  reminderEnabled: boolean;
  reminderMinutesBefore: number;
  category: string;
  createdAt: string;
  completedAt?: string;
}

export interface Target {
  id: string;
  title: string;
  description?: string;
  deadline: string; // ISO string
  focusLockEnabled: boolean;
  focusLockDurationMinutes: number;
  progress: number; // 0-100
  tasks: string[]; // task IDs
  createdAt: string;
}

export interface CallSchedule {
  id: string;
  contactName: string;
  contactPhone: string;
  scheduledAt: string; // ISO string
  note?: string;
  isRecurring: boolean;
  recurringDays?: number[]; // 0=Sun, 1=Mon, ...6=Sat
  recurringTime?: string; // HH:MM
  isCompleted: boolean;
  createdAt: string;
}

export interface FocusSession {
  id: string;
  targetId?: string;
  title: string;
  durationMinutes: number;
  startedAt: string; // ISO string
  endsAt: string; // ISO string
  isActive: boolean;
  blockedApps: string[];
}

export interface IntruderRecord {
  id: string;
  photoUri: string;
  timestamp: string; // ISO string
  attemptType: 'pin' | 'pattern' | 'password' | 'biometric';
}

export interface AppSettings {
  intruderDetectionEnabled: boolean;
  intruderMaxAttempts: number;
  focusLockStrict: boolean; // true = no way to exit except timer
  defaultReminderMinutes: number;
  theme: 'dark' | 'light';
  passcode?: string; // 4-6 digit PIN to exit focus mode
}
