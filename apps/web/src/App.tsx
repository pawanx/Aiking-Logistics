import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { WalletPage } from './pages/WalletPage';
import { ContactsPage } from './pages/ContactsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CallsPage } from './pages/CallsPage';
import { TenantsPage } from './pages/TenantsPage';

const ProtectedRoute: React.FC<{ children: React.ReactNode; requireSuperAdmin?: boolean }> = ({
  children,
  requireSuperAdmin = false,
}) => {
  const { user, token } = useAuth();

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  if (requireSuperAdmin && !user.isSuperAdmin) {
    return <Navigate to="/" replace />;
  }

  return <AppShell>{children}</AppShell>;
};

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/wallet"
            element={
              <ProtectedRoute>
                <WalletPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/contacts"
            element={
              <ProtectedRoute>
                <ContactsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/contacts/:id"
            element={
              <ProtectedRoute>
                <ContactDetailPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/templates"
            element={
              <ProtectedRoute>
                <TemplatesPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/campaigns"
            element={
              <ProtectedRoute>
                <CampaignsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/calls"
            element={
              <ProtectedRoute>
                <CallsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/tenants"
            element={
              <ProtectedRoute requireSuperAdmin>
                <TenantsPage />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
};
