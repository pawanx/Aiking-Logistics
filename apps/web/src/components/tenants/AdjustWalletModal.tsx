import React, { useState } from 'react';
import { X, Plus, ShieldCheck, AlertCircle, Sparkles } from 'lucide-react';
import { api } from '../../api/client';

interface AdjustWalletModalProps {
  isOpen: boolean;
  tenant: any;
  onClose: () => void;
  onSuccess: () => void;
}

export const AdjustWalletModal: React.FC<AdjustWalletModalProps> = ({
  isOpen,
  tenant,
  onClose,
  onSuccess,
}) => {
  const [amountRupees, setAmountRupees] = useState('500');
  const [reason, setReason] = useState('Special promotion / customer credit grant');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !tenant) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const rupees = parseFloat(amountRupees);
    if (isNaN(rupees) || rupees <= 0) {
      setError('Please enter a valid positive amount');
      return;
    }

    if (!reason.trim()) {
      setError('Audit reason is required for platform balance adjustments');
      return;
    }

    setIsSubmitting(true);
    try {
      const amountPaise = Math.round(rupees * 100).toString();
      await api.wallet.adjust({
        tenantId: tenant.id,
        amountPaise,
        reason: reason.trim(),
      });
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to adjust tenant wallet balance');
    } finally {
      setIsSubmitting(false);
    }
  };

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
        zIndex: 10000,
        padding: '20px',
      }}
    >
      <div
        className="data-card"
        style={{
          width: '100%',
          maxWidth: '520px',
          padding: 0,
          borderRadius: '16px',
          overflow: 'hidden',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        }}
      >
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
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="badge badge-indigo">
                <ShieldCheck size={12} /> Super Admin
              </span>
            </div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 0 0' }}>
              Credit / Adjust Tenant Balance
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '2px 0 0 0' }}>
              Target: <strong>{tenant.name}</strong> ({tenant.slug})
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: '6px',
              borderRadius: '8px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '24px' }}>
          {error && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                padding: '12px 16px',
                borderRadius: '8px',
                color: '#991b1b',
                fontSize: '0.85rem',
                marginBottom: '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <div style={{ marginBottom: '18px' }}>
            <label className="form-label" style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>
              Amount to Credit (₹)
            </label>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              {['500', '1000', '2500', '5000'].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmountRupees(preset)}
                  className={`btn btn-sm ${amountRupees === preset ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1 }}
                >
                  ₹{preset}
                </button>
              ))}
            </div>
            <input
              type="number"
              min="1"
              step="1"
              value={amountRupees}
              onChange={(e) => setAmountRupees(e.target.value)}
              className="input-field"
              placeholder="e.g. 500"
              required
              style={{ width: '100%', fontSize: '1.1rem', fontWeight: 700 }}
            />
          </div>

          <div style={{ marginBottom: '24px' }}>
            <label className="form-label" style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>
              Audit & Ledger Reason
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="input-field"
              rows={3}
              placeholder="e.g. Promotional credit grant or billing reconciliation"
              required
              style={{ width: '100%', resize: 'vertical' }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              This note is permanently recorded in the tenant's immutable double-entry ledger.
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting} className="btn btn-emerald">
              <Sparkles size={16} />
              <span>{isSubmitting ? 'Granting...' : 'Grant Balance Credit'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
