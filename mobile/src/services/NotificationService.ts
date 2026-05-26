import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { Task, CallSchedule } from '../types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export class NotificationService {
  static async requestPermissions(): Promise<boolean> {
    const { status: existing } = await Notifications.getPermissionsAsync();
    if (existing === 'granted') return true;

    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  }

  static async scheduleTaskReminder(task: Task): Promise<string | null> {
    if (!task.reminderEnabled || !task.dueDate) return null;

    const dueDate = new Date(task.dueDate);
    if (task.dueTime) {
      const [h, m] = task.dueTime.split(':').map(Number);
      dueDate.setHours(h, m, 0, 0);
    }

    const reminderDate = new Date(dueDate.getTime() - task.reminderMinutesBefore * 60 * 1000);
    if (reminderDate <= new Date()) return null;

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: `Task Reminder: ${task.title}`,
        body: `${task.reminderMinutesBefore} minutes mein deadline hai!`,
        data: { type: 'task_reminder', taskId: task.id },
        sound: true,
        priority: Notifications.AndroidNotificationPriority.HIGH,
        color: '#e94560',
      },
      trigger: { date: reminderDate },
    });
    return id;
  }

  static async scheduleCallReminder(call: CallSchedule): Promise<string | null> {
    const scheduledDate = new Date(call.scheduledAt);
    if (scheduledDate <= new Date()) return null;

    // 5 minute pehle notification
    const notifyDate = new Date(scheduledDate.getTime() - 5 * 60 * 1000);

    const reminderId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `Call Reminder`,
        body: `5 minute mein ${call.contactName} ko call karna hai`,
        data: { type: 'call_reminder', callId: call.id, phone: call.contactPhone },
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        color: '#4caf50',
      },
      trigger: notifyDate > new Date() ? { date: notifyDate } : { seconds: 5 },
    });

    // Exact time pe notification (direct call launch ke liye)
    const callId = await Notifications.scheduleNotificationAsync({
      content: {
        title: `Call ${call.contactName} NOW`,
        body: `${call.contactPhone} - Call karne ka time ho gaya!`,
        data: { type: 'call_now', callId: call.id, phone: call.contactPhone },
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        color: '#ff5722',
        vibrate: [0, 500, 250, 500],
      },
      trigger: { date: scheduledDate },
    });

    return callId;
  }

  static async scheduleFocusEnd(sessionId: string, endsAt: Date): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Focus Mode Khatam!',
        body: 'Aapka focus session complete hua. Shabash!',
        data: { type: 'focus_end', sessionId },
        sound: true,
        color: '#9c27b0',
      },
      trigger: { date: endsAt },
    });
  }

  static async scheduleIntruderAlert(attemptCount: number): Promise<void> {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Intruder Alert! (${attemptCount} attempts)`,
        body: 'Koi aapka phone unlock karne ki koshish kar raha hai!',
        data: { type: 'intruder_alert' },
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        color: '#f44336',
        vibrate: [0, 1000, 500, 1000],
      },
      trigger: null,
    });
  }

  static async cancelNotification(id: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(id);
  }

  static async cancelAllNotifications(): Promise<void> {
    await Notifications.cancelAllScheduledNotificationsAsync();
  }

  static addNotificationListener(
    handler: (notification: Notifications.Notification) => void
  ) {
    return Notifications.addNotificationReceivedListener(handler);
  }

  static addResponseListener(
    handler: (response: Notifications.NotificationResponse) => void
  ) {
    return Notifications.addNotificationResponseReceivedListener(handler);
  }
}
