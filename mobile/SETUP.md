# AP FocusLock - Mobile App Setup Guide

## Features

| Feature | Description |
|---------|-------------|
| Intruder Detection | Galat unlock pe front camera se photo |
| Task Manager | Din bhar ke tasks with priority & reminders |
| Targets | Long-term goals with progress tracking |
| Call Scheduler | Kisi ko bhi specific time pe call reminder |
| Focus Lock | Phone bilkul band, kuch nahi kar sakte |

## Requirements

- Node.js 18+
- Android Studio (Android build ke liye)
- Expo CLI: `npm install -g expo-cli eas-cli`

## Installation

```bash
cd mobile
npm install
```

## Run karo (Development)

```bash
# Expo Go app se (limited features)
npx expo start

# Android pe direct (full features ke liye)
npx expo run:android
```

## Production Build (APK)

```bash
# EAS account chahiye (free)
eas login
eas build --platform android --profile preview
```

## Permissions Jo Milegi (First Launch)

App pehli baar open karte waqt ye permissions maangegi:
1. **Camera** - Intruder detection ke liye
2. **Contacts** - Call scheduler mein contact search ke liye
3. **Notifications** - Reminders ke liye
4. **Device Admin** - Focus Lock + intruder detection (system level)

## Intruder Detection Kaise Setup Kare

1. Security tab pe jaao
2. "Camera Permission Do" pe tap karo
3. Settings > Apps > AP FocusLock > Device Admin enable karo
4. Bas! Ab agar koi galat PIN daalega toh photo khicchegi

## Focus Lock Mode

### Normal Mode
- Focus shuru karo, kisi bhi waqt band kar sakte ho

### Strict Mode
- Settings > Focus Lock > Strict Mode ON
- Passcode set karo
- Focus mode mein phone USE NAHI HO SAKTA
- Sirf passcode dalke exit ho sakta hai
- Timer khatam hone pe automatic unlock

## Architecture

```
mobile/
├── App.tsx                          # Entry point
├── src/
│   ├── navigation/AppNavigator.tsx  # Tab navigation
│   ├── screens/
│   │   ├── HomeScreen.tsx           # Dashboard
│   │   ├── TasksScreen.tsx          # Task manager
│   │   ├── TargetsScreen.tsx        # Goals/targets
│   │   ├── FocusModeScreen.tsx      # Focus timer + lock
│   │   ├── CallSchedulerScreen.tsx  # Call scheduling
│   │   ├── SecurityScreen.tsx       # Intruder photos
│   │   └── SettingsScreen.tsx       # App settings
│   ├── services/
│   │   ├── NotificationService.ts   # Push notifications
│   │   ├── IntruderService.ts       # Camera capture logic
│   │   └── CallService.ts           # Phone + contacts
│   ├── store/appStore.ts            # Zustand global state
│   └── types/index.ts               # TypeScript types
└── android/
    └── app/src/main/java/com/appartners/focuslock/
        ├── DeviceAdminReceiver.java      # Wrong attempts listener
        ├── IntruderBroadcastReceiver.java # Attempt counter
        ├── IntruderCaptureService.java    # Background camera service
        ├── IntruderDetectionModule.java   # React Native bridge
        └── BootReceiver.java              # Post-reboot restart
```
