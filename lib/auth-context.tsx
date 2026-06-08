import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiRequest } from '@/lib/query-client';
import type { User, UserRole } from '@shared/schema';

type SafeUser = Omit<User, 'password'>;

interface AuthContextValue {
  user: SafeUser | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<SafeUser>;
  register: (data: {
    username: string;
    password: string;
    fullName: string;
    phone: string;
    role: UserRole;
    vehicleInfo?: {
      make: string;
      model: string;
      year: string;
      color: string;
      plate: string;
    };
  }) => Promise<SafeUser>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem('rideflow_user');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (!parsed?.id) {
            await AsyncStorage.removeItem('rideflow_user');
          } else {
            const res = await apiRequest('GET', `/api/user/${parsed.id}`);
            const fresh = await res.json();
            if (fresh?.id) {
              setUser(fresh);
              await AsyncStorage.setItem('rideflow_user', JSON.stringify(fresh));
            } else {
              await AsyncStorage.removeItem('rideflow_user');
            }
          }
        }
      } catch {
        await AsyncStorage.removeItem('rideflow_user');
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const login = async (username: string, password: string): Promise<SafeUser> => {
    await AsyncStorage.removeItem('rideflow_user');
    setUser(null);
    const res = await apiRequest('POST', '/api/auth/login', { username, password });
    const userData = await res.json();
    await AsyncStorage.setItem('rideflow_user', JSON.stringify(userData));
    setUser(userData);
    return userData;
  };

  const register = async (data: {
    username: string;
    password: string;
    fullName: string;
    phone: string;
    role: UserRole;
    vehicleInfo?: {
      make: string;
      model: string;
      year: string;
      color: string;
      plate: string;
    };
  }): Promise<SafeUser> => {
    const res = await apiRequest('POST', '/api/auth/register', data);
    const userData = await res.json();
    await AsyncStorage.setItem('rideflow_user', JSON.stringify(userData));
    setUser(userData);
    return userData;
  };

  const logout = async () => {
    await AsyncStorage.removeItem('rideflow_user');
    setUser(null);
  };

  const refreshUser = async () => {
    if (!user?.id) return;
    try {
      const res = await apiRequest('GET', `/api/user/${user.id}`);
      const fresh = await res.json();
      setUser(fresh);
    } catch {}
  };

  const value = useMemo(() => ({
    user,
    isLoading,
    login,
    register,
    logout,
    refreshUser,
  }), [user, isLoading]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
