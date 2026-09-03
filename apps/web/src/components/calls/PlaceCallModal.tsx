import React, { useState } from 'react';
import { X, PhoneCall, AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { api } from '../../api/client';

interface PlaceCallModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  defaultPhone?: string;
}

export const PlaceCallModal: React.FC<PlaceCallModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  defaultPhone = '+919876543210',
}) => {
  const [phone, setPhone] = useState(defaultPhone);
  const [prompt, setPrompt] = useState('Confirm address for scheduled afternoon delivery of shipment AGI-8492.');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await api.calls.place({
        toPhone: phone,
        prompt,
      });

      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to place call');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'var(--accent-violet-light)',
                border: '1px solid var(--accent-violet-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <PhoneCall size={20} color="#7c3aed" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', fontWeight: 800 }}>Connect Client Call</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Plivo Dial + Recording + AI Intelligence</div>
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
              Client Phone Number (E.164) *
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
              Call Purpose / Agenda *
            </label>
            <textarea
              rows={3}
              required
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="input-field"
              placeholder="e.g. Confirm address for scheduled afternoon delivery of shipment AGI-8492."
              style={{ resize: 'vertical' }}
            />
          </div>

          <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', gap: '8px' }}>
            <Sparkles size={16} color="#7c3aed" style={{ flexShrink: 0, marginTop: '2px' }} />
            <span>
              Plivo dials and connects the client, recording the conversation. Upon completion, the audio transcript is analyzed by Gemini AI to produce an executive summary, actionable next steps, and priority rating.
            </span>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-emerald btn-lg"
            style={{ marginTop: '8px', width: '100%' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Connecting Client...
              </>
            ) : (
              'Connect Client Call'
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
