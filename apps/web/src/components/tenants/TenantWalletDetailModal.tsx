import React, { useState, useEffect } from 'react';
import {
  X,
  Wallet,
  ArrowUpRight,
  ArrowDownLeft,
  CreditCard,
  Sparkles,
  RefreshCw,
  Building2,
  Calendar,
  AlertCircle,
  PlusCircle,
  Receipt,
  CheckCircle2,
} from 'lucide-react';
import { api } from '../../api/client';

interface TenantWalletDetailModalProps {
  isOpen: boolean;
  tenant: any;
  onClose: () => void;
  onOpenAdjust: (tenant: any) => void;
}

export const TenantWalletDetailModal: React.FC<TenantWalletDetailModalProps> = ({
  isOpen,
  tenant,
  onClose,
  onOpenAdjust,
}) => {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'recharges' | 'usage'>('all');

  const fetchTenantWallet = async () => {
    if (!tenant?.id) return;
    setIsLoading(true);
    try {
      const res = await api.wallet.getTenantWallet(tenant.id);
      setData(res);
    } catch (err) {
      console.error('Failed to fetch tenant wallet:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && tenant?.id) {
      fetchTenantWallet();
    }
  }, [isOpen, tenant?.id]);

  if (!isOpen || !tenant) return null;

  const summary = data?.summary || tenant.wallet;
  const transactions: any[] = data?.transactions || [];

  const rechargeTransactions = transactions.filter(
    (tx) => tx.type === 'topup_credit' || tx.type === 'free_credit_grant',
  );

  const usageTransactions = transactions.filter(
    (tx) => tx.type === 'usage_debit' || tx.type === 'free_credit_debit',
  );

  const displayedTransactions =
    activeTab === 'recharges'
      ? rechargeTransactions
      : activeTab === 'usage'
      ? usageTransactions
      : transactions;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '20px',
      }}
    >
      <div
        className="data-card"
        style={{
          width: '100%',
          maxWidth: '850px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          borderRadius: '16px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                background: '#004e9f',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
              }}
            >
              <Building2 size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                  {tenant.name}
                </h2>
                <span className="badge badge-indigo" style={{ textTransform: 'uppercase' }}>
                  {tenant.plan || 'Standard'}
                </span>
                <span className={`badge ${tenant.status === 'active' ? 'badge-emerald' : 'badge-rose'}`}>
                  {tenant.status?.toUpperCase()}
                </span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '2px 0 0 0' }}>
                Tenant Slug: <span style={{ fontFamily: 'var(--font-mono)' }}>{tenant.slug}</span> | ID: {tenant.id}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => onOpenAdjust(tenant)}
              className="btn btn-emerald btn-sm"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <PlusCircle size={14} />
              <span>Credit / Adjust Balance</span>
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                padding: '6px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {/* Summary Cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '14px',
              marginBottom: '24px',
            }}
          >
            {/* Total Recharged */}
            <div
              className="data-card"
              style={{
                padding: '16px',
                background: '#f0fdf4',
                border: '1px solid #bbf7d0',
              }}
            >
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#166534', textTransform: 'uppercase' }}>
                Total Paid Recharges
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#14532d', margin: '4px 0' }}>
                {summary?.totalRecharged?.formatted || '₹0.00'}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#15803d', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <CheckCircle2 size={12} />
                <span>{summary?.rechargeCount ?? 0} Top-ups completed</span>
              </div>
            </div>

            {/* Total Spendable Available */}
            <div
              className="data-card"
              style={{
                padding: '16px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
              }}
            >
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#1e40af', textTransform: 'uppercase' }}>
                Current Available Balance
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#1e3a8a', margin: '4px 0' }}>
                {summary?.availableBalance?.formatted || summary?.balance?.formatted || '₹0.00'}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#3b82f6' }}>
                Spendable float
              </div>
            </div>

            {/* Paid vs Free Split */}
            <div className="data-card" style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Paid vs Free Split
              </div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '6px' }}>
                Paid: <span style={{ color: '#166534' }}>{summary?.paidBalance?.formatted || '₹0.00'}</span>
              </div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
                Free Credits: <span style={{ color: '#004e9f' }}>{summary?.freeCreditBalance?.formatted || '₹0.00'}</span>
              </div>
            </div>

            {/* Total Spent */}
            <div className="data-card" style={{ padding: '16px' }}>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Lifetime Usage Spent
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#be123c', margin: '4px 0' }}>
                {summary?.totalSpent?.formatted || '₹0.00'}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                WhatsApp, Email & Calls
              </div>
            </div>
          </div>

          {/* Ledger Tabs */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px',
              borderBottom: '1px solid var(--border-color)',
              paddingBottom: '12px',
            }}
          >
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setActiveTab('all')}
                className={`btn btn-sm ${activeTab === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              >
                All Movements ({transactions.length})
              </button>
              <button
                onClick={() => setActiveTab('recharges')}
                className={`btn btn-sm ${activeTab === 'recharges' ? 'btn-primary' : 'btn-secondary'}`}
              >
                Top-ups & Grants ({rechargeTransactions.length})
              </button>
              <button
                onClick={() => setActiveTab('usage')}
                className={`btn btn-sm ${activeTab === 'usage' ? 'btn-primary' : 'btn-secondary'}`}
              >
                Usage Debits ({usageTransactions.length})
              </button>
            </div>

            <button
              onClick={fetchTenantWallet}
              className="btn btn-secondary btn-sm"
              disabled={isLoading}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
              <span>Refresh Ledger</span>
            </button>
          </div>

          {/* Transactions Table */}
          <div className="table-container" style={{ border: '1px solid var(--border-color)', borderRadius: '12px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Bucket</th>
                  <th>Amount</th>
                  <th>Balance After</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                      Loading ledger transactions...
                    </td>
                  </tr>
                ) : displayedTransactions.length > 0 ? (
                  displayedTransactions.map((tx: any) => {
                    const isCredit =
                      tx.type === 'topup_credit' ||
                      tx.type === 'free_credit_grant' ||
                      tx.amount?.rupees > 0;
                    return (
                      <tr key={tx.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div
                              style={{
                                width: '28px',
                                height: '28px',
                                borderRadius: '8px',
                                background: isCredit ? '#dcfce7' : '#fee2e2',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              {isCredit ? (
                                <ArrowDownLeft size={14} color="#166534" />
                              ) : (
                                <ArrowUpRight size={14} color="#991b1b" />
                              )}
                            </div>
                            <span style={{ fontWeight: 600, fontSize: '0.8rem', textTransform: 'capitalize' }}>
                              {tx.type.replace(/_/g, ' ')}
                            </span>
                          </div>
                        </td>
                        <td style={{ fontSize: '0.85rem' }}>
                          <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{tx.description}</div>
                          {tx.referenceType && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              Ref: {tx.referenceType} ({tx.referenceId || 'N/A'})
                            </div>
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge ${tx.bucket === 'paid' ? 'badge-emerald' : 'badge-indigo'}`}
                            style={{ fontSize: '0.7rem' }}
                          >
                            {tx.bucket?.toUpperCase() || 'PAID'}
                          </span>
                        </td>
                        <td
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontWeight: 700,
                            color: isCredit ? '#166534' : '#991b1b',
                          }}
                        >
                          {isCredit ? '+' : ''}
                          {tx.amount?.formatted || `₹${Math.abs(tx.amount?.rupees || 0).toFixed(2)}`}
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                          {tx.balanceAfter?.formatted || '—'}
                        </td>
                        <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                          {new Date(tx.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                      No ledger transactions found in this view.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'flex-end',
            background: '#f8fafc',
          }}
        >
          <button onClick={onClose} className="btn btn-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
