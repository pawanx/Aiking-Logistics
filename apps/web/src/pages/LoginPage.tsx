import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Shield, Building2, User, AlertCircle, Loader2, ArrowRight } from 'lucide-react';
import { useAuth, QUICK_PERSONAS } from '../context/AuthContext';

export const LoginPage: React.FC = () => {
  const { login, quickLogin } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Invalid email or password');
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuick = async (key: keyof typeof QUICK_PERSONAS) => {
    setIsLoading(true);
    setError(null);
    try {
      await quickLogin(key);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Quick login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #f9f9ff 0%, #edf2f9 100%)',
        padding: '24px',
      }}
    >
      <div style={{ width: '100%', maxWidth: '440px' }}>
        {/* Brand Header */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div
            style={{
              width: '54px',
              height: '54px',
              borderRadius: '14px',
              background: 'linear-gradient(135deg, #004e9f 0%, #2563eb 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px auto',
              boxShadow: '0 8px 24px rgba(0, 78, 159, 0.25)',
            }}
          >
            <Zap size={30} color="#fff" />
          </div>
          <h1 style={{ fontSize: '1.85rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>
            Aiking Connect
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '6px' }}>
            AI Customer Communication & Operations Platform
          </p>
        </div>

        {/* Main Card */}
        <div className="data-card" style={{ padding: '32px' }}>
          {error && (
            <div
              style={{
                padding: '12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--accent-rose-light)',
                border: '1px solid var(--accent-rose-border)',
                color: '#9f1239',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '20px',
              }}
            >
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {/* Quick 1-Click Fast Test Personas */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>
              ⚡ 1-Click Fast Test Personas
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                type="button"
                onClick={() => handleQuick('manager')}
                className="btn btn-secondary"
                style={{
                  width: '100%',
                  justifyContent: 'space-between',
                  padding: '11px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: '#ffffff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Building2 size={16} color="#34a853" />
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>Demo Tenant Manager</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>manager@demo.example</div>
                  </div>
                </div>
                <ArrowRight size={14} color="#64748b" />
              </button>

              <button
                type="button"
                onClick={() => handleQuick('admin')}
                className="btn btn-secondary"
                style={{
                  width: '100%',
                  justifyContent: 'space-between',
                  padding: '11px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: '#ffffff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Shield size={16} color="#004e9f" />
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>Platform Super Admin</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>admin@aiking.example</div>
                  </div>
                </div>
                <ArrowRight size={14} color="#64748b" />
              </button>

              <button
                type="button"
                onClick={() => handleQuick('staff')}
                className="btn btn-secondary"
                style={{
                  width: '100%',
                  justifyContent: 'space-between',
                  padding: '11px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: '#ffffff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <User size={16} color="#7c3aed" />
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>Demo Tenant Staff</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>staff@demo.example</div>
                  </div>
                </div>
                <ArrowRight size={14} color="#64748b" />
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '20px 0' }}>
            <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Or Sign In With Email</span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                Email Address
              </label>
              <input
                type="email"
                required
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-field"
              />
            </div>

            <div>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                Password
              </label>
              <input
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="btn btn-primary btn-lg"
              style={{ marginTop: '10px', width: '100%' }}
            >
              {isLoading ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Signing In...
                </>
              ) : (
                'Sign In to Dashboard'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
