import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApiUrl } from '@/lib/query-client';

export async function connectRealtime(
  onMessage: (message: { type?: string; data?: Record<string, unknown> }) => void,
): Promise<() => void> {
  const token = await AsyncStorage.getItem('rideflow_access_token');
  if (!token || typeof WebSocket === 'undefined') return () => undefined;

  const url = new URL('/ws', getApiUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  const socket = new WebSocket(url.toString());
  socket.onmessage = event => {
    try {
      const message = JSON.parse(String(event.data));
      onMessage(message);
    } catch {
      // Malformed realtime data must not affect polling or ride state.
    }
  };
  return () => socket.close();
}
