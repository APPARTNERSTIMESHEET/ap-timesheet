import { Linking, Platform } from 'react-native';
import * as Contacts from 'expo-contacts';
import { CallSchedule } from '../types';
import { NotificationService } from './NotificationService';

export class CallService {
  static async requestContactsPermission(): Promise<boolean> {
    const { status } = await Contacts.requestPermissionsAsync();
    return status === 'granted';
  }

  static async searchContacts(query: string): Promise<Contacts.Contact[]> {
    const { status } = await Contacts.getPermissionsAsync();
    if (status !== 'granted') return [];

    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
    });

    if (!query.trim()) return data.slice(0, 20);

    return data.filter(c =>
      c.name?.toLowerCase().includes(query.toLowerCase()) ||
      c.phoneNumbers?.some(p => p.number?.includes(query))
    ).slice(0, 10);
  }

  static async makeCall(phoneNumber: string): Promise<boolean> {
    const cleaned = phoneNumber.replace(/\s|-|\(|\)/g, '');
    const url = `tel:${cleaned}`;

    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) {
      await Linking.openURL(url);
      return true;
    }
    return false;
  }

  static async scheduleCall(call: CallSchedule): Promise<void> {
    await NotificationService.scheduleCallReminder(call);
  }

  static async cancelCall(call: CallSchedule): Promise<void> {
    // Cancel associated notifications - tracked by callId in notification data
  }

  static getUpcomingCalls(calls: CallSchedule[]): CallSchedule[] {
    const now = new Date();
    return calls
      .filter(c => !c.isCompleted && new Date(c.scheduledAt) > now)
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  }

  static getOverdueCalls(calls: CallSchedule[]): CallSchedule[] {
    const now = new Date();
    return calls
      .filter(c => !c.isCompleted && new Date(c.scheduledAt) < now)
      .sort((a, b) => new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime());
  }

  static formatPhoneForDisplay(phone: string): string {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
    }
    return phone;
  }
}
