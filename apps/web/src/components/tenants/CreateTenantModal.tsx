import React, { useState } from 'react';
import { X, Building2, AlertCircle, Loader2, Sparkles, CheckCircle2 } from 'lucide-react';
import { api } from '../../api/client';

interface CreateTenantModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateTenantModal: React.FC<CreateTenantModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [plan, setPlan] = useState('growth');
  const [managerFullName, setManagerFullName] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [managerPassword, setManagerPassword] = useState('pass123');
  const [freeCreditsRupees, setFreeCreditsRupees] = useState('500');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successData, setSuccessData] = useState<any>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const freeCreditsPaise = (parseInt(freeCreditsRupees, 10) * 100).toString();
      const res = await api.tenants.onboard({
        name,
        slug: slug || undefined,
        plan,
        managerFullName,
        managerEmail,
        managerPassword: managerPassword || undefined,
        freeCreditsPaise,
      });

      setSuccessData(res);
      setTimeout(() => {
        onSuccess();
      }, 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to onboard tenant organization');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNameChange = (val: string) => {
    setName(val);
    if (!slug) {
      setSlug(
        val
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
      );
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '580px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'var(--brand-blue-light)',
                border: '1px solid var(--brand-blue-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Building2 size={20} color="#004e9f" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Onboard Tenant Organization</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Provisions isolated database workspace, wallet, and manager</div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

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
              marginBottom: '16px',
            }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {successData ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: 'var(--action-green-light)',
                border: '1px solid var(--action-green-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px auto',
              }}
            >
              <CheckCircle2 size={32} color="#166534" />
            </div>
            <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
              Tenant Onboarded Successfully!
            </h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Organization <strong>{successData.tenant?.name}</strong> has been provisioned with{' '}
              {successData.freeCreditsGranted?.formatted || '₹500.00'} welcome credit.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                  Organization Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Apex Fast Freight"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className="input-field"
                />
              </div>

              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                  Slug (URL key)
                </label>
                <input
                  type="text"
                  placeholder="apex-fast-freight"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="input-field"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                  Plan Tier
                </label>
                <select value={plan} onChange={(e) => setPlan(e.target.value)} className="input-field">
                  <option value="starter">Starter Plan</option>
                  <option value="growth">Growth Plan</option>
                  <option value="enterprise">Enterprise Plan</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                  Welcome Promotional Credits (₹)
                </label>
                <input
                  type="number"
                  min="0"
                  value={freeCreditsRupees}
                  onChange={(e) => setFreeCreditsRupees(e.target.value)}
                  className="input-field"
                />
              </div>
            </div>

            <div style={{ padding: '14px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--brand-blue)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Initial Manager Account
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                    Manager Full Name *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Sunil Verma"
                    value={managerFullName}
                    onChange={(e) => setManagerFullName(e.target.value)}
                    className="input-field"
                  />
                </div>

                <div>
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                    Manager Email *
                  </label>
                  <input
                    type="email"
                    required
                    placeholder="sunil@apex.example"
                    value={managerEmail}
                    onChange={(e) => setManagerEmail(e.target.value)}
                    className="input-field"
                  />
                </div>
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                  Manager Initial Password *
                </label>
                <input
                  type="text"
                  required
                  placeholder="pass123"
                  value={managerPassword}
                  onChange={(e) => setManagerPassword(e.target.value)}
                  className="input-field"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="btn btn-emerald btn-lg"
              style={{ marginTop: '8px', width: '100%' }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Provisioning Organization...
                </>
              ) : (
                'Onboard Organization Now'
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
