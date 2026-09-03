import React, { useState, useEffect, useMemo } from 'react';
import {
  Building2,
  Shield,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Ban,
  Plus,
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  Sparkles,
  Search,
  Receipt,
  Coins,
  TrendingUp,
  CreditCard,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { CreateTenantModal } from '../components/tenants/CreateTenantModal';
import { TenantWalletDetailModal } from '../components/tenants/TenantWalletDetailModal';
import { AdjustWalletModal } from '../components/tenants/AdjustWalletModal';

export const TenantsPage: React.FC = () => {
  const [tenants, setTenants] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedWalletTenant, setSelectedWalletTenant] = useState<any | null>(null);
  const [selectedAdjustTenant, setSelectedAdjustTenant] = useState<any | null>(null);

  const fetchTenants = async () => {
    setIsLoading(true);
    try {
      const res = await api.tenants.list();
      setTenants(res.items || []);
    } catch (err) {
      console.error('Failed to fetch tenants:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleToggleSuspend = async (tenant: any) => {
    try {
      if (tenant.status === 'suspended') {
        await api.tenants.resume(tenant.id);
      } else {
        await api.tenants.suspend(tenant.id, 'Administrative review');
      }
      fetchTenants();
    } catch (err) {
      console.error('Failed to update tenant status:', err);
    }
  };

  // Platform-wide Super Admin aggregates
  const platformStats = useMemo(() => {
    let totalRechargedRupees = 0;
    let totalAvailableRupees = 0;
    let totalPaidFloatRupees = 0;
    let totalFreeFloatRupees = 0;
    let totalSpentRupees = 0;
    let activeCount = 0;
    let totalContacts = 0;

    for (const t of tenants) {
      if (t.status === 'active') activeCount++;
      totalContacts += t.contactCount || 0;

      if (t.wallet) {
        totalRechargedRupees += t.wallet.totalRecharged?.rupees || 0;
        totalAvailableRupees += t.wallet.availableBalance?.rupees || t.wallet.balance?.rupees || 0;
        totalPaidFloatRupees += t.wallet.paidBalance?.rupees || 0;
        totalFreeFloatRupees += t.wallet.freeCreditBalance?.rupees || 0;
        totalSpentRupees += t.wallet.totalSpent?.rupees || 0;
      }
    }

    return {
      totalRecharged: `₹${totalRechargedRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      totalAvailable: `₹${totalAvailableRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      totalPaidFloat: `₹${totalPaidFloatRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      totalFreeFloat: `₹${totalFreeFloatRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      totalSpent: `₹${totalSpentRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      activeCount,
      totalCount: tenants.length,
      totalContacts,
    };
  }, [tenants]);

  // Filtered list
  const filteredTenants = useMemo(() => {
    return tenants.filter((t) => {
      const matchesSearch =
        t.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.slug?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.id?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.contactEmail?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && t.status === 'active') ||
        (statusFilter === 'suspended' && t.status === 'suspended');

      return matchesSearch && matchesStatus;
    });
  }, [tenants, searchQuery, statusFilter]);

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '24px',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span className="badge badge-indigo">
              <Shield size={12} /> Super Admin Control Center
            </span>
            <span className="badge badge-emerald">Software Vendor View</span>
          </div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>
            Client Organizations & Wallet Financials
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
            Platform-wide tenant oversight, lifetime customer top-up revenue, and real-time float balances
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={fetchTenants} className="btn btn-secondary" disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
          <button onClick={() => setIsCreateOpen(true)} className="btn btn-emerald">
            <Plus size={16} />
            <span>Onboard New Tenant</span>
          </button>
        </div>
      </div>

      {/* Super Admin Financial KPI Summary Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '16px',
          marginBottom: '28px',
        }}
      >
        {/* Total Recharges / Platform Revenue */}
        <div
          className="data-card"
          style={{
            padding: '20px',
            background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)',
            border: '1px solid #bbf7d0',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#166534', textTransform: 'uppercase' }}>
              Total Recharges Collected
            </div>
            <Coins size={20} color="#166534" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#14532d', margin: '8px 0 4px 0' }}>
            {platformStats.totalRecharged}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#15803d', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <TrendingUp size={14} />
            <span>Gross Razorpay Top-up Payments</span>
          </div>
        </div>

        {/* Total Spendable Float */}
        <div
          className="data-card"
          style={{
            padding: '20px',
            background: 'linear-gradient(135deg, #ffffff 0%, #eff6ff 100%)',
            border: '1px solid #bfdbfe',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#1e40af', textTransform: 'uppercase' }}>
              Total Active Float in Wallets
            </div>
            <Wallet size={20} color="#1e40af" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#1e3a8a', margin: '8px 0 4px 0' }}>
            {platformStats.totalAvailable}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#3b82f6' }}>
            Paid Cash: <strong>{platformStats.totalPaidFloat}</strong> | Promo: {platformStats.totalFreeFloat}
          </div>
        </div>

        {/* Total Lifetime Usage Debits */}
        <div className="data-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Total Platform Usage Consumed
            </div>
            <Receipt size={20} color="var(--text-muted)" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#991b1b', margin: '8px 0 4px 0' }}>
            {platformStats.totalSpent}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            WhatsApp, Emails & AI Voice Minutes
          </div>
        </div>

        {/* Active Organizations */}
        <div className="data-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Client Organizations
            </div>
            <Building2 size={20} color="var(--text-muted)" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', margin: '8px 0 4px 0' }}>
            {platformStats.activeCount} <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>/ {platformStats.totalCount} active</span>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Managing {platformStats.totalContacts} registered customer contacts
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div
        className="data-card"
        style={{
          padding: '16px 20px',
          marginBottom: '20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '280px' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '400px' }}>
            <Search
              size={16}
              style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
            />
            <input
              type="text"
              placeholder="Search by company name, slug, email, or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input-field"
              style={{ paddingLeft: '36px', width: '100%' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => setStatusFilter('all')}
              className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            >
              All ({tenants.length})
            </button>
            <button
              onClick={() => setStatusFilter('active')}
              className={`btn btn-sm ${statusFilter === 'active' ? 'btn-primary' : 'btn-secondary'}`}
            >
              Active ({platformStats.activeCount})
            </button>
            <button
              onClick={() => setStatusFilter('suspended')}
              className={`btn btn-sm ${statusFilter === 'suspended' ? 'btn-primary' : 'btn-secondary'}`}
            >
              Suspended ({tenants.length - platformStats.activeCount})
            </button>
          </div>
        </div>
      </div>

      {/* Tenants Table */}
      <div className="data-card" style={{ overflow: 'hidden' }}>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Status & Plan</th>
                <th style={{ background: '#f0fdf4' }}>Total Recharged</th>
                <th>Available Balance</th>
                <th>Usage Spent</th>
                <th>Contacts</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTenants.length > 0 ? (
                filteredTenants.map((t) => {
                  const isSuspended = t.status === 'suspended';
                  const totalRechargedStr = t.wallet?.totalRecharged?.formatted || '₹0.00';
                  const rechargeCount = t.wallet?.rechargeCount || 0;
                  const availableStr = t.wallet?.availableBalance?.formatted || t.wallet?.balance?.formatted || '₹0.00';
                  const paidStr = t.wallet?.paidBalance?.formatted || '₹0.00';
                  const freeStr = t.wallet?.freeCreditBalance?.formatted || '₹0.00';
                  const spentStr = t.wallet?.totalSpent?.formatted || '₹0.00';

                  return (
                    <tr key={t.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '38px',
                              height: '38px',
                              borderRadius: '10px',
                              background: '#eff6ff',
                              border: '1px solid #bfdbfe',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Building2 size={18} color="#004e9f" />
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              {t.slug}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <span className={`badge ${isSuspended ? 'badge-rose' : 'badge-emerald'}`} style={{ width: 'fit-content' }}>
                            {isSuspended ? <Ban size={12} /> : <CheckCircle2 size={12} />}
                            {t.status?.toUpperCase() || 'ACTIVE'}
                          </span>
                          <span className="badge badge-slate" style={{ width: 'fit-content', fontSize: '0.7rem' }}>
                            {t.plan?.toUpperCase() || 'STANDARD'}
                          </span>
                        </div>
                      </td>

                      {/* Total Recharged Column */}
                      <td style={{ background: '#f0fdf4' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: '#166534', fontSize: '1rem' }}>
                          {totalRechargedStr}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#15803d' }}>
                          {rechargeCount > 0 ? `${rechargeCount} top-up${rechargeCount > 1 ? 's' : ''}` : 'No paid top-ups yet'}
                        </div>
                      </td>

                      {/* Available Balance Column */}
                      <td>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {availableStr}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          Paid: {paidStr} | Free: {freeStr}
                        </div>
                      </td>

                      {/* Usage Spent Column */}
                      <td>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#be123c' }}>
                          {spentStr}
                        </div>
                      </td>

                      {/* Contacts */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                          <Users size={14} />
                          <span>{t.contactCount ?? 0}</span>
                        </div>
                      </td>

                      <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        {new Date(t.createdAt).toLocaleDateString()}
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                          <button
                            onClick={() => setSelectedWalletTenant(t)}
                            className="btn btn-secondary btn-sm"
                            title="View Wallet Ledger & Recharge History"
                            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                          >
                            <Wallet size={14} />
                            <span>Wallet & Ledger</span>
                          </button>

                          <button
                            onClick={() => setSelectedAdjustTenant(t)}
                            className="btn btn-secondary btn-sm"
                            title="Credit or Adjust Balance"
                            style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                          >
                            <Plus size={14} />
                            <span>Credit</span>
                          </button>

                          <button
                            onClick={() => handleToggleSuspend(t)}
                            className={isSuspended ? 'btn btn-secondary btn-sm' : 'btn btn-danger-outline btn-sm'}
                          >
                            {isSuspended ? 'Resume' : 'Suspend'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>
                    {isLoading ? 'Loading tenant organizations...' : 'No tenant organizations matched your criteria.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Onboard Tenant Modal */}
      {isCreateOpen && (
        <CreateTenantModal
          isOpen={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          onSuccess={() => {
            fetchTenants();
            setIsCreateOpen(false);
          }}
        />
      )}

      {/* Tenant Wallet Detail Modal */}
      {selectedWalletTenant && (
        <TenantWalletDetailModal
          isOpen={!!selectedWalletTenant}
          tenant={selectedWalletTenant}
          onClose={() => setSelectedWalletTenant(null)}
          onOpenAdjust={(t) => {
            setSelectedWalletTenant(null);
            setSelectedAdjustTenant(t);
          }}
        />
      )}

      {/* Adjust / Grant Balance Modal */}
      {selectedAdjustTenant && (
        <AdjustWalletModal
          isOpen={!!selectedAdjustTenant}
          tenant={selectedAdjustTenant}
          onClose={() => setSelectedAdjustTenant(null)}
          onSuccess={() => {
            fetchTenants();
            setSelectedAdjustTenant(null);
          }}
        />
      )}
    </div>
  );
};
