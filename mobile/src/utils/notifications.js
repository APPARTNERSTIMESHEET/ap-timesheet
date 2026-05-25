import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform, Linking } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function requestPermissions() {
  if (!Device.isDevice) return false;
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

export async function scheduleReminder({ id, title, body, scheduledTime, callNumber }) {
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});

  const trigger = new Date(scheduledTime);
  if (trigger <= new Date()) return null;

  const notifId = await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: {
      title,
      body,
      sound: true,
      priority: Notifications.AndroidNotificationPriority.MAX,
      data: { callNumber, reminderId: id },
      categoryIdentifier: callNumber ? 'CALL_REMINDER' : 'REMINDER',
    },
    trigger,
  });

  return notifId;
}

export async function cancelReminder(id) {
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
}

export async function setupNotificationCategories() {
  await Notifications.setNotificationCategoryAsync('CALL_REMINDER', [
    {
      identifier: 'CALL_NOW',
      buttonTitle: 'Call Now',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'DISMISS',
      buttonTitle: 'Dismiss',
      options: { isDestructive: true },
    },
  ]);

  await Notifications.setNotificationCategoryAsync('REMINDER', [
    {
      identifier: 'DONE',
      buttonTitle: 'Mark Done',
      options: { opensAppToForeground: false },
    },
    {
      identifier: 'DISMISS',
      buttonTitle: 'Dismiss',
      options: { isDestructive: true },
    },
  ]);
}

export function handleNotificationResponse(response, onCallPressed) {
  const { actionIdentifier, notification } = response;
  const { callNumber } = notification.request.content.data || {};

  if (actionIdentifier === 'CALL_NOW' && callNumber) {
    makeCall(callNumber);
  }

  if (typeof onCallPressed === 'function' && callNumber) {
    onCallPressed(callNumber);
  }
}

export async function makeCall(phoneNumber) {
  const url = `tel:${phoneNumber}`;
  const canOpen = await Linking.canOpenURL(url);
  if (canOpen) {
    await Linking.openURL(url);
  }
}

export function formatTime(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export function formatDate(date) {
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
