import React, { useState } from 'react';
import { X, UserPlus, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../api/client';

interface CreateContactModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const CreateContactModal: React.FC<CreateContactModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [whatsappOptedIn, setWhatsappOptedIn] = useState(true);
  const [emailOptedIn, setEmailOptedIn] = useState(true);
  const [tagInput, setTagInput] = useState('enterprise, priority');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const tags = tagInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      await api.contacts.create({
        fullName,
        phone,
        email: email || undefined,
        whatsappOptedIn,
        emailOptedIn,
        tags,
      });

      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to create contact');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
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
              <UserPlus size={20} color="#004e9f" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Add CRM Contact</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Customer details & channel permissions</div>
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

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Full Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Ramesh Patel"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input-field"
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Phone Number (E.164 format) *
            </label>
            <input
              type="tel"
              required
              placeholder="+919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="input-field"
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Email Address (Optional)
            </label>
            <input
              type="email"
              placeholder="ramesh@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Tags (Comma separated)
            </label>
            <input
              type="text"
              placeholder="vip, delivery, delhi-hub"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              className="input-field"
            />
          </div>

          <div style={{ padding: '14px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={whatsappOptedIn}
                onChange={(e) => setWhatsappOptedIn(e.target.checked)}
              />
              <span>WhatsApp Communication Opt-in</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={emailOptedIn}
                onChange={(e) => setEmailOptedIn(e.target.checked)}
              />
              <span>Email Notification Opt-in</span>
            </label>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-primary btn-lg"
            style={{ marginTop: '8px', width: '100%' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Adding Contact...
              </>
            ) : (
              'Save Contact'
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
