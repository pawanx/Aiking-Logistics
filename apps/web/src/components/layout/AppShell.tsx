import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Send,
  FileText,
  PhoneCall,
  Wallet,
  Building2,
  LogOut,
  PlusCircle,
  ExternalLink,
  Shield,
  Zap,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import { useAuth, QUICK_PERSONAS } from '../../context/AuthContext';
import { api } from '../../api/client';
import { TopupModal } from '../wallet/TopupModal';

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, logout, quickLogin } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [isTopupOpen, setIsTopupOpen] = useState<boolean>(false);
  const [isPersonaMenuOpen, setIsPersonaMenuOpen] = useState<boolean>(false);

  const fetchWallet = async () => {
    if (!user || user.isSuperAdmin) return;
    try {
      const data = await api.wallet.get();
      const bal = data.summary.availableBalance || data.summary.effectiveBalance || data.summary.balance;
      setWalletBalance(bal?.formatted || '₹500.00');
    } catch {
      // Wallet might not exist yet for unseeded tenants
    }
  };

  useEffect(() => {
    fetchWallet();
  }, [user]);

  const navItems = [
    { label: 'Dashboard', path: '/', icon: LayoutDashboard, role: 'all' },
    { label: 'Contacts CRM', path: '/contacts', icon: Users, role: 'all' },
    { label: 'Campaigns', path: '/campaigns', icon: Send, role: 'all' },
    { label: 'Templates', path: '/templates', icon: FileText, role: 'all' },
    { label: 'AI Voice Calls', path: '/calls', icon: PhoneCall, role: 'all' },
    { label: 'Wallet & Billing', path: '/wallet', icon: Wallet, role: 'all' },
    ...(user?.isSuperAdmin
      ? [{ label: 'Tenants (Admin)', path: '/tenants', icon: Building2, role: 'super_admin' }]
      : []),
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', width: '100%', background: 'var(--bg-canvas)' }}>
      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside
        style={{
          width: '260px',
          background: '#ffffff',
          borderRight: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          position: 'fixed',
          top: 0,
          bottom: 0,
          left: 0,
          zIndex: 30,
        }}
      >
        {/* Brand Header */}
        <div style={{ padding: '22px 20px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '38px',
              height: '38px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #004e9f 0%, #2563eb 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 3px 8px rgba(0, 78, 159, 0.25)',
            }}
          >
            <Zap size={20} color="#fff" />
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '1.05rem', letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Aiking Connect</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>AI Communications Hub</div>
          </div>
        </div>

        {/* Tenant Active Context */}
        <div style={{ padding: '12px 16px', margin: '14px 12px 0 12px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>Active Context</div>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {user?.isSuperAdmin ? <Shield size={14} color="#004e9f" /> : <Building2 size={14} color="#34a853" />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.isSuperAdmin ? 'Platform Root' : user?.tenantName || 'Demo Connect'}
            </span>
          </div>
        </div>

        {/* Navigation links */}
        <nav style={{ flex: 1, padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.875rem',
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? '#004e9f' : 'var(--text-secondary)',
                  background: isActive ? '#eff6ff' : 'transparent',
                  borderLeft: isActive ? '3px solid #004e9f' : '3px solid transparent',
                  transition: 'all 0.15s ease',
                }}
              >
                <Icon size={18} color={isActive ? '#004e9f' : '#64748b'} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* External Docs Link */}
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-subtle)' }}>
          <a
            href="http://localhost:3001/api/docs"
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '9px 12px',
              borderRadius: 'var(--radius-md)',
              background: '#f8fafc',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              fontSize: '0.8rem',
              fontWeight: 600,
            }}
          >
            <span>Swagger API Explorer</span>
            <ExternalLink size={14} color="#64748b" />
          </a>
        </div>

        {/* User Card */}
        <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border-subtle)', background: '#ffffff' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  background: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  color: '#004e9f',
                }}
              >
                {user?.fullName?.charAt(0) || 'U'}
              </div>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {user?.fullName}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>
                  {user?.role?.replace('_', ' ')}
                </div>
              </div>
            </div>
            <button
              onClick={logout}
              title="Logout"
              className="btn btn-ghost btn-sm"
              style={{ padding: '6px', color: 'var(--text-muted)' }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main Content Canvas ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, marginLeft: '260px', display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        {/* Top Header */}
        <header
          style={{
            height: '64px',
            background: 'rgba(255, 255, 255, 0.85)',
            backdropFilter: 'blur(12px)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 36px',
            position: 'sticky',
            top: 0,
            zIndex: 20,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 500 }}>Workspace:</span>
            <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {user?.tenantName || (user?.isSuperAdmin ? 'Platform Management (Super Admin)' : 'Demo Connect Co.')}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            {/* Wallet Balance widget (Tenant context) */}
            {!user?.isSuperAdmin && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  background: '#f8fafc',
                  border: '1px solid var(--border-subtle)',
                  padding: '5px 14px',
                  borderRadius: 'var(--radius-pill)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}>
                  <Wallet size={15} color="#34a853" />
                  <span style={{ color: 'var(--text-muted)' }}>Wallet:</span>
                  <span style={{ fontWeight: 700, color: '#166534' }}>{walletBalance || '₹500.00'}</span>
                </div>
                <button
                  onClick={() => setIsTopupOpen(true)}
                  className="btn btn-emerald btn-sm"
                  style={{ padding: '4px 10px', fontSize: '0.75rem', borderRadius: 'var(--radius-pill)' }}
                >
                  <PlusCircle size={13} />
                  <span>Top Up</span>
                </button>
              </div>
            )}

            {/* Quick Persona Switcher */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setIsPersonaMenuOpen(!isPersonaMenuOpen)}
                className="btn btn-secondary btn-sm"
                style={{ display: 'flex', alignItems: 'center', gap: '6px', borderRadius: 'var(--radius-pill)' }}
              >
                <RefreshCw size={13} />
                <span>Switch Persona</span>
                <ChevronDown size={13} />
              </button>

              {isPersonaMenuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 8px)',
                    width: '280px',
                    background: '#ffffff',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '8px',
                    boxShadow: '0 12px 30px rgba(0,0,0,0.1)',
                    zIndex: 50,
                  }}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '6px 10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Fast Test Personas
                  </div>
                  {Object.entries(QUICK_PERSONAS).map(([key, p]) => (
                    <button
                      key={key}
                      onClick={async () => {
                        setIsPersonaMenuOpen(false);
                        await quickLogin(key as any);
                        navigate('/');
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '9px 12px',
                        background: user?.email === p.email ? '#eff6ff' : 'transparent',
                        border: 'none',
                        borderRadius: 'var(--radius-md)',
                        color: user?.email === p.email ? '#004e9f' : 'var(--text-primary)',
                        cursor: 'pointer',
                        display: 'block',
                        transition: 'background-color 0.1s ease',
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>{p.label}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{p.email}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Content Body */}
        <main style={{ flex: 1, padding: '36px', maxWidth: '1440px', width: '100%', margin: '0 auto' }}>
          {children}
        </main>
      </div>

      {/* Topup Modal */}
      {isTopupOpen && (
        <TopupModal
          isOpen={isTopupOpen}
          onClose={() => setIsTopupOpen(false)}
          onSuccess={() => {
            fetchWallet();
            setIsTopupOpen(false);
          }}
        />
      )}
    </div>
  );
};
