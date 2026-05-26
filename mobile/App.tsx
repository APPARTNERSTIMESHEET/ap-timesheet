import React, { useEffect } from 'react';
import { LogBox, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import AppNavigator from './src/navigation/AppNavigator';
import { useAppStore } from './src/store/appStore';
import { NotificationService } from './src/services/NotificationService';
import { CallService } from './src/services/CallService';

LogBox.ignoreLogs(['Warning:', 'Non-serializable values were found']);

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const { loadAll } = useAppStore();

  useEffect(() => {
    loadAll();
    NotificationService.requestPermissions();
    CallService.requestContactsPermission();

    // Handle notification tap (e.g., tap "Call NOW" notification to open dialer)
    const sub = NotificationService.addResponseListener(response => {
      const data = response.notification.request.content.data as any;
      if (data?.type === 'call_now' && data.phone) {
        CallService.makeCall(data.phone);
      }
    });

    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppNavigator />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
