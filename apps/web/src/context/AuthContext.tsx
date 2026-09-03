import React, { createContext, useContext, useState, useEffect } from 'react';
import { api, ApiError } from '../api/client';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'super_admin' | 'manager' | 'staff';
  tenantId: string | null;
  tenantName: string | null;
  isSuperAdmin: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  quickLogin: (persona: 'admin' | 'manager' | 'staff') => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const QUICK_PERSONAS = {
  admin: {
    label: 'Platform Super Admin',
    email: 'admin@aiking.example',
    password: 'admin123',
    role: 'super_admin',
    description: 'Manage platform tenants, system pricing & infra',
  },
  manager: {
    label: 'Demo Tenant Manager',
    email: 'manager@demo.example',
    password: 'demo123',
    role: 'manager',
    description: 'Full tenant operations, campaigns, wallet top-ups, AI calls',
  },
  staff: {
    label: 'Demo Tenant Staff',
    email: 'staff@demo.example',
    password: 'demo123',
    role: 'staff',
    description: 'CRM contacts, templates & outbound communications',
  },
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const saved = localStorage.getItem('aiking_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('aiking_token'));
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const login = async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await api.auth.login({ email, password });
      setUser(res.user as AuthUser);
      setToken(res.accessToken);
      localStorage.setItem('aiking_token', res.accessToken);
      localStorage.setItem('aiking_user', JSON.stringify(res.user));
    } finally {
      setIsLoading(false);
    }
  };

  const quickLogin = async (persona: 'admin' | 'manager' | 'staff') => {
    const p = QUICK_PERSONAS[persona];
    await login(p.email, p.password);
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('aiking_token');
    localStorage.removeItem('aiking_user');
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout, quickLogin }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
