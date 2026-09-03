import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Phone,
  Mail,
  MessageSquare,
  PhoneCall,
  Clock,
  CheckCircle2,
  Calendar,
  Sparkles,
} from 'lucide-react';
import { api } from '../api/client';
import { PlaceCallModal } from '../components/calls/PlaceCallModal';

export const ContactDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [contact, setContact] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [isCallOpen, setIsCallOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const loadContact = async () => {
    if (!id) return;
    setIsLoading(true);
    try {
      const [contactData, timelineData] = await Promise.all([
        api.contacts.get(id),
        api.contacts.getTimeline(id),
      ]);
      setContact(contactData);
      setTimeline(timelineData.timeline || []);
    } catch (err) {
      console.error('Failed to load contact details:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadContact();
  }, [id]);

  if (isLoading) {
    return <div style={{ color: 'var(--text-muted)', padding: '40px' }}>Loading 360° interaction timeline...</div>;
  }

  return (
    <div>
      {/* Header Back Button */}
      <button
        onClick={() => navigate('/contacts')}
        className="btn btn-ghost btn-sm"
        style={{ marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '6px' }}
      >
        <ArrowLeft size={16} />
        <span>Back to Contacts</span>
      </button>

      {/* Two Column Layout: Profile Card & 360° Timeline */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '28px' }}>
        {/* Left Column: Customer Profile */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="data-card" style={{ padding: '28px' }}>
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: '#eff6ff',
                border: '2px solid #bfdbfe',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '1.4rem',
                color: '#004e9f',
                marginBottom: '16px',
              }}
            >
              {contact?.fullName?.charAt(0) || 'C'}
            </div>

            <h2 style={{ fontSize: '1.4rem', color: 'var(--text-primary)', marginBottom: '4px' }}>
              {contact?.fullName}
            </h2>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
              Customer Record · {contact?.id?.slice(0, 10)}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Phone size={16} color="#64748b" />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {contact?.phone}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Mail size={16} color="#64748b" />
                <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  {contact?.email || 'No email registered'}
                </span>
              </div>
            </div>

            {/* Channel Opt-in Badges */}
            <div style={{ marginTop: '20px', borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
                Channel Permissions
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {contact?.whatsappOptedIn ? (
                  <span className="badge badge-emerald">
                    <CheckCircle2 size={12} /> WhatsApp Enabled
                  </span>
                ) : (
                  <span className="badge badge-slate">WhatsApp Disabled</span>
                )}
                {contact?.emailOptedIn ? (
                  <span className="badge badge-indigo">
                    <CheckCircle2 size={12} /> Email Enabled
                  </span>
                ) : (
                  <span className="badge badge-slate">Email Disabled</span>
                )}
              </div>
            </div>

            {/* Action button */}
            <button
              onClick={() => setIsCallOpen(true)}
              className="btn btn-emerald btn-lg"
              style={{ marginTop: '24px', width: '100%' }}
            >
              <PhoneCall size={18} />
              <span>Place AI Call to Customer</span>
            </button>
          </div>
        </div>

        {/* Right Column: 360° Timeline */}
        <div className="data-card" style={{ padding: '28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
            <div>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)' }}>360° Interaction Timeline</h3>
              <p style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                Unified chronological feed of WhatsApp messages, AI phone calls, and email broadcasts
              </p>
            </div>
            <span className="badge badge-indigo">{timeline.length} Events</span>
          </div>

          {/* Timeline Stream */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', position: 'relative', paddingLeft: '24px' }}>
            {/* Vertical Line */}
            <div
              style={{
                position: 'absolute',
                left: '7px',
                top: '12px',
                bottom: '12px',
                width: '2px',
                background: 'var(--border-subtle)',
              }}
            />

            {timeline.length > 0 ? (
              timeline.map((event: any, idx: number) => {
                const isCall = event.type === 'call';
                const isWA = event.type === 'whatsapp';
                const isEmail = event.type === 'email';

                return (
                  <div key={idx} style={{ position: 'relative' }}>
                    {/* Node Dot */}
                    <div
                      style={{
                        position: 'absolute',
                        left: '-24px',
                        top: '4px',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: '#ffffff',
                        border: isCall ? '3px solid #7c3aed' : isWA ? '3px solid #34a853' : '3px solid #004e9f',
                        boxShadow: '0 0 0 3px #ffffff',
                      }}
                    />

                    {/* Content Box */}
                    <div
                      style={{
                        padding: '16px',
                        background: '#f8fafc',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span
                            className={`badge ${
                              isCall ? 'badge-slate' : isWA ? 'badge-emerald' : 'badge-indigo'
                            }`}
                            style={{ textTransform: 'uppercase' }}
                          >
                            {isCall && <PhoneCall size={11} />}
                            {isWA && <MessageSquare size={11} />}
                            {isEmail && <Mail size={11} />}
                            {event.type}
                          </span>
                          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                            {event.title || event.description || 'Interaction Record'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          <Clock size={12} />
                          <span>{new Date(event.timestamp).toLocaleString()}</span>
                        </div>
                      </div>

                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        {event.summary || event.details || event.content || 'Dispatched via Aiking Gateway'}
                      </div>

                      {event.duration && (
                        <div style={{ marginTop: '8px', fontSize: '0.75rem', color: '#7c3aed', fontWeight: 600 }}>
                          Duration: {event.duration} seconds
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', padding: '20px 0' }}>
                No past interactions recorded for this contact yet. Click "Place AI Call" to start the first conversation!
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Place Call Modal */}
      {isCallOpen && (
        <PlaceCallModal
          isOpen={isCallOpen}
          defaultPhone={contact?.phone}
          onClose={() => setIsCallOpen(false)}
          onSuccess={() => {
            loadContact();
            setIsCallOpen(false);
          }}
        />
      )}
    </div>
  );
};
