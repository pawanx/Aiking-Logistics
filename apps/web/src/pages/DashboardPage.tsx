import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Wallet,
  Users,
  Send,
  PhoneCall,
  ArrowUpRight,
  Plus,
  CreditCard,
  TrendingUp,
  Sparkles,
  Zap,
  CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { TopupModal } from '../components/wallet/TopupModal';

export const DashboardPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [wallet, setWallet] = useState<any>(null);
  const [pricing, setPricing] = useState<any>(null);
  const [contactsCount, setContactsCount] = useState<number>(0);
  const [campaignsCount, setCampaignsCount] = useState<number>(0);
  const [callsCount, setCallsCount] = useState<number>(0);
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = async () => {
    setIsLoading(true);
    try {
      if (!user?.isSuperAdmin) {
        const [walletRes, pricingRes, contactsRes, campaignsRes, callsRes] = await Promise.allSettled([
          api.wallet.get(),
          api.wallet.getEffectivePricing(),
          api.contacts.list({ limit: 1 }),
          api.campaigns.list(),
          api.calls.list(),
        ]);

        if (walletRes.status === 'fulfilled') setWallet(walletRes.value);
        if (pricingRes.status === 'fulfilled') setPricing(pricingRes.value);
        if (contactsRes.status === 'fulfilled') setContactsCount(contactsRes.value.page.totalItems || 0);
        if (campaignsRes.status === 'fulfilled') setCampaignsCount(campaignsRes.value.items?.length || 0);
        if (callsRes.status === 'fulfilled') setCallsCount(callsRes.value.items?.length || 0);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user]);

  return (
    <div>
      {/* Welcome Banner Card */}
      <div
        className="data-card"
        style={{
          padding: '28px 32px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f0f7ff 100%)',
          border: '1px solid #bfdbfe',
          marginBottom: '32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '20px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span className="badge badge-emerald">
              <CheckCircle2 size={12} /> System Operational
            </span>
            <span className="badge badge-blue">
              <Zap size={12} /> Mock Provider Mode
            </span>
          </div>
          <h2 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>
            Welcome back, {user?.fullName || 'Manager'}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.925rem', marginTop: '4px' }}>
            {user?.tenantName || 'Demo Connect Co.'} · AI Communications & Customer Engagement Portal
          </p>
        </div>

        {!user?.isSuperAdmin && (
          <button onClick={() => setIsTopupOpen(true)} className="btn btn-emerald btn-lg">
            <CreditCard size={18} />
            <span>Top Up Wallet</span>
          </button>
        )}
      </div>

      {/* Metric Cards Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        {/* Wallet Balance Card */}
        <div className="data-card" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Available Balance
            </span>
            <div style={{ padding: '8px', borderRadius: '10px', background: 'var(--action-green-light)', border: '1px solid var(--action-green-border)' }}>
              <Wallet size={20} color="#166534" />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            {wallet?.summary?.availableBalance?.formatted || wallet?.summary?.effectiveBalance?.formatted || wallet?.summary?.balance?.formatted || '₹500.00'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span>Free promotional:</span>
            <span style={{ color: '#166534', fontWeight: 700 }}>{wallet?.summary?.freeCreditBalance?.formatted || '₹500.00'}</span>
          </div>
        </div>

        {/* Contacts CRM Card */}
        <div className="data-card data-card-interactive" onClick={() => navigate('/contacts')} style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              CRM Contacts
            </span>
            <div style={{ padding: '8px', borderRadius: '10px', background: 'var(--brand-blue-light)', border: '1px solid var(--brand-blue-border)' }}>
              <Users size={20} color="#004e9f" />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
            {contactsCount || 4}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '8px', fontSize: '0.8rem', color: '#004e9f', fontWeight: 600 }}>
            <span>Manage customer records</span>
            <ArrowUpRight size={14} />
          </div>
        </div>

        {/* Campaigns Card */}
        <div className="data-card data-card-interactive" onClick={() => navigate('/campaigns')} style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Campaigns
            </span>
            <div style={{ padding: '8px', borderRadius: '10px', background: 'var(--accent-amber-light)', border: '1px solid var(--accent-amber-border)' }}>
              <Send size={20} color="#92400e" />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
            {campaignsCount || 1}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '8px', fontSize: '0.8rem', color: '#b45309', fontWeight: 600 }}>
            <span>View broadcast history</span>
            <ArrowUpRight size={14} />
          </div>
        </div>

        {/* AI Phone Calls Card */}
        <div className="data-card data-card-interactive" onClick={() => navigate('/calls')} style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              AI Voice Calls
            </span>
            <div style={{ padding: '8px', borderRadius: '10px', background: 'var(--accent-violet-light)', border: '1px solid var(--accent-violet-border)' }}>
              <PhoneCall size={20} color="#7c3aed" />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>
            {callsCount || 2}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '8px', fontSize: '0.8rem', color: '#7c3aed', fontWeight: 600 }}>
            <span>Voice call console</span>
            <ArrowUpRight size={14} />
          </div>
        </div>
      </div>

      {/* Two Column Section: Action Bar & Rate Sheet */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '24px' }}>
        {/* Glassmorphic Action Bar */}
        <div className="glass-action-bar" style={{ padding: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Instant Launchpad</h3>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Trigger immediate voice calls, broadcast dispatches, or manage records
              </p>
            </div>
            <Sparkles size={20} color="#004e9f" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px' }}>
            <button
              onClick={() => navigate('/calls')}
              className="btn btn-secondary"
              style={{
                padding: '18px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '10px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ padding: '8px', borderRadius: '8px', background: 'var(--accent-violet-light)' }}>
                <PhoneCall size={20} color="#7c3aed" />
              </div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: '0.925rem', color: 'var(--text-primary)' }}>Place AI Call</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Trigger outbound voice bot</div>
              </div>
            </button>

            <button
              onClick={() => navigate('/campaigns')}
              className="btn btn-secondary"
              style={{
                padding: '18px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '10px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ padding: '8px', borderRadius: '8px', background: 'var(--accent-amber-light)' }}>
                <Send size={20} color="#92400e" />
              </div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: '0.925rem', color: 'var(--text-primary)' }}>Launch Campaign</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Broadcast WhatsApp/Email</div>
              </div>
            </button>

            <button
              onClick={() => navigate('/contacts')}
              className="btn btn-secondary"
              style={{
                padding: '18px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '10px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ padding: '8px', borderRadius: '8px', background: 'var(--brand-blue-light)' }}>
                <Users size={20} color="#004e9f" />
              </div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: '0.925rem', color: 'var(--text-primary)' }}>Add CRM Contact</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Register customer details</div>
              </div>
            </button>

            <button
              onClick={() => setIsTopupOpen(true)}
              className="btn btn-secondary"
              style={{
                padding: '18px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '10px',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ padding: '8px', borderRadius: '8px', background: 'var(--action-green-light)' }}>
                <Wallet size={20} color="#166534" />
              </div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: '0.925rem', color: 'var(--text-primary)' }}>Add Balance</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Razorpay top-up gateway</div>
              </div>
            </button>
          </div>
        </div>

        {/* Effective Pricing Rate Sheet */}
        <div className="data-card" style={{ padding: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
            <h3 style={{ fontSize: '1.15rem', color: 'var(--text-primary)' }}>Channel Rate Sheet</h3>
            <TrendingUp size={18} color="#004e9f" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 16px',
                background: '#f8fafc',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>WhatsApp Messaging</div>
                <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>Meta Cloud API template</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: '#004e9f', fontFamily: 'var(--font-mono)' }}>
                  {pricing?.whatsapp_message?.formatted || '₹0.75'}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>/ msg</div>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 16px',
                background: '#f8fafc',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>AI Voice Telephony</div>
                <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>Plivo + Deepgram + LLM</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: '#004e9f', fontFamily: 'var(--font-mono)' }}>
                  {pricing?.ai_call_minute?.formatted || '₹4.50'}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>/ min</div>
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 16px',
                background: '#f8fafc',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>Email Broadcast</div>
                <div style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>Amazon SES delivery</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '1rem', fontWeight: 800, color: '#004e9f', fontFamily: 'var(--font-mono)' }}>
                  {pricing?.email_message?.formatted || '₹0.10'}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>/ email</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Topup Modal */}
      {isTopupOpen && (
        <TopupModal
          isOpen={isTopupOpen}
          onClose={() => setIsTopupOpen(false)}
          onSuccess={() => {
            loadData();
            setIsTopupOpen(false);
          }}
        />
      )}
    </div>
  );
};
