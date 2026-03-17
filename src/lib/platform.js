import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();

export const platformPrefix = isNative
  ? (Capacitor.getPlatform() === 'ios' ? 'IOS' : 'AND')
  : 'PWA';
