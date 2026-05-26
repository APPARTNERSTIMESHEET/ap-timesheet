import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, StyleSheet } from 'react-native';

import HomeScreen from '../screens/HomeScreen';
import TasksScreen from '../screens/TasksScreen';
import TargetsScreen from '../screens/TargetsScreen';
import FocusModeScreen from '../screens/FocusModeScreen';
import CallSchedulerScreen from '../screens/CallSchedulerScreen';
import SecurityScreen from '../screens/SecurityScreen';
import SettingsScreen from '../screens/SettingsScreen';
import { useAppStore } from '../store/appStore';

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

function TabNavigator() {
  const { intruderRecords, activeFocusSession } = useAppStore();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: '#7c4dff',
        tabBarInactiveTintColor: '#555',
        tabBarLabelStyle: styles.tabLabel,
        tabBarIcon: ({ color, size, focused }) => {
          const icons: Record<string, [string, string]> = {
            Home: ['home', 'home-outline'],
            Tasks: ['checkbox', 'checkbox-outline'],
            Targets: ['flag', 'flag-outline'],
            Focus: ['lock-closed', 'lock-open-outline'],
            Calls: ['call', 'call-outline'],
            Security: ['shield', 'shield-outline'],
          };
          const [active, inactive] = icons[route.name] || ['ellipse', 'ellipse-outline'];
          const iconName = focused ? active : inactive;

          if (route.name === 'Security' && intruderRecords.length > 0) {
            return (
              <View>
                <Ionicons name={iconName as any} size={size} color={color} />
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{intruderRecords.length}</Text>
                </View>
              </View>
            );
          }
          if (route.name === 'Focus' && activeFocusSession) {
            return (
              <View>
                <Ionicons name={iconName as any} size={size} color="#9c27b0" />
                <View style={[styles.dot, { backgroundColor: '#9c27b0' }]} />
              </View>
            );
          }
          return <Ionicons name={iconName as any} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
      <Tab.Screen name="Tasks" component={TasksScreen} options={{ tabBarLabel: 'Tasks' }} />
      <Tab.Screen name="Targets" component={TargetsScreen} options={{ tabBarLabel: 'Targets' }} />
      <Tab.Screen name="Focus" component={FocusModeScreen} options={{ tabBarLabel: 'Focus' }} />
      <Tab.Screen name="Calls" component={CallSchedulerScreen} options={{ tabBarLabel: 'Calls' }} />
      <Tab.Screen name="Security" component={SecurityScreen} options={{ tabBarLabel: 'Security' }} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Main" component={TabNavigator} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: '#12122a',
    borderTopColor: '#1a1a35',
    borderTopWidth: 1,
    height: 65,
    paddingBottom: 8,
    paddingTop: 4,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
  badge: {
    position: 'absolute', top: -4, right: -8,
    backgroundColor: '#f44336', borderRadius: 8,
    minWidth: 16, height: 16,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 2,
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: 'bold' },
  dot: { position: 'absolute', top: 0, right: 0, width: 8, height: 8, borderRadius: 4 },
});
