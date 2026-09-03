import React, { useState } from 'react';
import { X, CreditCard, CheckCircle2, AlertCircle, Loader2, Sparkles, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';

interface TopupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const PRESET_AMOUNTS = [
  { label: '₹100', paise: '10000', rupees: 100 },
  { label: '₹500', paise: '50000', rupees: 500 },
  { label: '₹1,000', paise: '100000', rupees: 1000 },
  { label: '₹5,000', paise: '500000', rupees: 5000 },
];

export const TopupModal: React.FC<TopupModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [selectedPaise, setSelectedPaise] = useState<string>('50000');
  const [customRupees, setCustomRupees] = useState<string>('');
  const [step, setStep] = useState<'select' | 'processing' | 'capture_ready' | 'success'>('select');
  const [orderData, setOrderData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  if (!isOpen) return null;

  const currentPaise = customRupees ? (parseInt(customRupees, 10) * 100).toString() : selectedPaise;
  const currentRupees = parseInt(currentPaise, 10) / 100;

  const handleCreateOrder = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await api.topups.create(currentPaise);
      setOrderData(res);
      setStep('capture_ready');
    } catch (err: any) {
      setError(err.message || 'Failed to create top-up order');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSimulateCapture = async () => {
    if (!orderData?.orderId) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await api.topups.mockCapture(orderData.orderId);
      setStep('success');
      setTimeout(() => {
        onSuccess();
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Payment simulation failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'var(--action-green-light)',
                border: '1px solid var(--action-green-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CreditCard size={20} color="#166534" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Top Up Wallet Credits</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Razorpay Instant Payment Gateway</div>
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
              marginBottom: '18px',
            }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: Amount selection */}
        {step === 'select' && (
          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '10px' }}>
              Select Amount (INR)
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '18px' }}>
              {PRESET_AMOUNTS.map((preset) => {
                const isSelected = selectedPaise === preset.paise && !customRupees;
                return (
                  <button
                    key={preset.paise}
                    type="button"
                    onClick={() => {
                      setSelectedPaise(preset.paise);
                      setCustomRupees('');
                    }}
                    style={{
                      padding: '16px',
                      borderRadius: 'var(--radius-md)',
                      background: isSelected ? '#eff6ff' : '#f8fafc',
                      border: isSelected ? '2px solid #004e9f' : '1px solid var(--border-subtle)',
                      color: isSelected ? '#004e9f' : 'var(--text-primary)',
                      fontWeight: 800,
                      fontSize: '1.05rem',
                      fontFamily: 'var(--font-mono)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      transition: 'all 0.1s ease',
                    }}
                  >
                    <span>{preset.label}</span>
                    {preset.rupees >= 1000 && <Sparkles size={14} color="#004e9f" />}
                  </button>
                );
              })}
            </div>

            <div style={{ marginBottom: '22px' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                Or Custom Amount (₹)
              </label>
              <input
                type="number"
                min="1"
                max="500000"
                placeholder="e.g. 2500"
                value={customRupees}
                onChange={(e) => setCustomRupees(e.target.value)}
                className="input-field"
              />
            </div>

            <button
              onClick={handleCreateOrder}
              disabled={isSubmitting || currentRupees <= 0}
              className="btn btn-emerald btn-lg"
              style={{ width: '100%' }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Creating Razorpay Order...
                </>
              ) : (
                `Proceed to Pay ₹${currentRupees.toLocaleString('en-IN')}`
              )}
            </button>
          </div>
        )}

        {/* Step 2: Simulated Razorpay Checkout */}
        {step === 'capture_ready' && (
          <div>
            <div
              style={{
                padding: '18px',
                borderRadius: 'var(--radius-md)',
                background: '#f8fafc',
                border: '1px solid #bfdbfe',
                marginBottom: '20px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Order ID:</span>
                <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)', color: '#004e9f', fontWeight: 600 }}>
                  {orderData?.razorpayOrderId}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Payable Amount:</span>
                <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#166534', fontFamily: 'var(--font-mono)' }}>
                  ₹{currentRupees.toLocaleString('en-IN')}.00
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Payment Mode:</span>
                <span className="badge badge-indigo">Mock Razorpay (UPI Simulation)</span>
              </div>
            </div>

            <p style={{ fontSize: '0.825rem', color: 'var(--text-secondary)', marginBottom: '22px', lineHeight: 1.5 }}>
              Clicking below sends an authentic Razorpay HMAC-signed webhook payload through BullMQ to credit the wallet immediately.
            </p>

            <button
              onClick={handleSimulateCapture}
              disabled={isSubmitting}
              className="btn btn-emerald btn-lg"
              style={{ width: '100%' }}
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Verifying Webhook & Crediting...
                </>
              ) : (
                `Simulate Payment Capture (₹${currentRupees.toLocaleString('en-IN')})`
              )}
            </button>
          </div>
        )}

        {/* Step 3: Success */}
        {step === 'success' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div
              style={{
                width: '60px',
                height: '60px',
                borderRadius: '50%',
                background: 'var(--action-green-light)',
                border: '1px solid var(--action-green-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px auto',
              }}
            >
              <CheckCircle2 size={34} color="#166534" />
            </div>
            <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)', marginBottom: '6px' }}>Top-up Successful!</h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              ₹{currentRupees.toLocaleString('en-IN')}.00 has been credited to your wallet balance.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
