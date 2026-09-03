import React, { useState, useEffect } from 'react';
import {
  Wallet,
  ArrowUpRight,
  ArrowDownLeft,
  CreditCard,
  Plus,
  RefreshCw,
  Sparkles,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { api } from '../api/client';
import { TopupModal } from '../components/wallet/TopupModal';

export const WalletPage: React.FC = () => {
  const [wallet, setWallet] = useState<any>(null);
  const [pricing, setPricing] = useState<any>(null);
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const fetchWalletData = async () => {
    setIsLoading(true);
    try {
      const [walletRes, pricingRes] = await Promise.all([
        api.wallet.get(),
        api.wallet.getEffectivePricing(),
      ]);
      setWallet(walletRes);
      setPricing(pricingRes);
    } catch (err) {
      console.error('Error fetching wallet:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchWalletData();
  }, []);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>Prepaid Wallet & Billing</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
            Real-time balance, double-entry audit ledger, and automated payment settlement
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={fetchWalletData} className="btn btn-secondary">
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
          <button onClick={() => setIsTopupOpen(true)} className="btn btn-emerald">
            <Plus size={16} />
            <span>Add Credits</span>
          </button>
        </div>
      </div>

      {/* Balance Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        {/* Total Usable Balance */}
        <div className="data-card" style={{ padding: '26px', border: '1px solid #bfdbfe', background: 'linear-gradient(135deg, #ffffff 0%, #eff6ff 100%)' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--brand-blue)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Total Usable Balance
          </div>
          <div style={{ fontSize: '2.4rem', fontWeight: 800, color: 'var(--text-primary)', margin: '10px 0 6px 0', letterSpacing: '-0.02em' }}>
            {wallet?.summary?.availableBalance?.formatted || wallet?.summary?.effectiveBalance?.formatted || wallet?.summary?.balance?.formatted || '₹500.00'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: '#166534', fontWeight: 600 }}>
            <Sparkles size={14} />
            <span>Active & Available for All Channels</span>
          </div>
        </div>

        {/* Free Credits */}
        <div className="data-card" style={{ padding: '26px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Welcome Promotional Credits
          </div>
          <div style={{ fontSize: '2.4rem', fontWeight: 800, color: '#004e9f', margin: '10px 0 6px 0', letterSpacing: '-0.02em' }}>
            {wallet?.summary?.freeCreditBalance?.formatted || '₹500.00'}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Deducted first before paid balance
          </div>
        </div>

        {/* Paid Balance */}
        <div className="data-card" style={{ padding: '26px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Razorpay Paid Balance
          </div>
          <div style={{ fontSize: '2.4rem', fontWeight: 800, color: '#166534', margin: '10px 0 6px 0', letterSpacing: '-0.02em' }}>
            {wallet?.summary?.paidBalance?.formatted || '₹0.00'}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Instant recharge with 0% gateway fees
          </div>
        </div>
      </div>

      {/* Two Column: Ledger & Pricing */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px' }}>
        {/* Transaction Ledger Table */}
        <div className="data-card" style={{ padding: '26px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Double-Entry Transaction Ledger</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Immutable financial record of all credits, reservations, and settlements
              </p>
            </div>
            <span className="badge badge-slate">{wallet?.transactions?.length || 0} Transactions</span>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {wallet?.transactions?.length > 0 ? (
                  wallet.transactions.map((tx: any) => {
                    const isCredit = tx.amount?.rupees > 0 || tx.type.includes('credit') || tx.type.includes('grant');
                    return (
                      <tr key={tx.id}>
                        <td>
                          <span className={`badge ${isCredit ? 'badge-emerald' : 'badge-rose'}`}>
                            {isCredit ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
                            {tx.type?.replace(/_/g, ' ')?.toUpperCase()}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{tx.description}</td>
                        <td style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: isCredit ? '#166534' : '#9f1239' }}>
                          {isCredit ? '+' : '-'}{tx.amount?.formatted || '₹0.00'}
                        </td>
                        <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                          {new Date(tx.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '36px' }}>
                      No ledger transactions recorded yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pricing Breakdown */}
        <div className="data-card" style={{ padding: '26px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Channel Pricing</h3>
            <TrendingUp size={18} color="#004e9f" />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ padding: '16px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                WHATSAPP MESSAGING
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#004e9f', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                {pricing?.whatsapp_message?.formatted || '₹0.75'}{' '}
                <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>/ delivered template</span>
              </div>
            </div>

            <div style={{ padding: '16px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                AI VOICE CALL (PER MINUTE)
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#004e9f', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                {pricing?.ai_call_minute?.formatted || '₹4.50'}{' '}
                <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>/ connected minute</span>
              </div>
            </div>

            <div style={{ padding: '16px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                EMAIL BROADCAST
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#004e9f', fontFamily: 'var(--font-mono)', marginTop: '4px' }}>
                {pricing?.email_message?.formatted || '₹0.10'}{' '}
                <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-muted)' }}>/ outbound message</span>
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
            fetchWalletData();
            setIsTopupOpen(false);
          }}
        />
      )}
    </div>
  );
};
