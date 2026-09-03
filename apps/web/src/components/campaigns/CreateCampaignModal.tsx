import React, { useState, useEffect } from 'react';
import { X, Send, AlertCircle, Loader2, Users, Tag } from 'lucide-react';
import { api } from '../../api/client';

interface CreateCampaignModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  prefillTags?: string[];
}

export const CreateCampaignModal: React.FC<CreateCampaignModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  prefillTags = [],
}) => {
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<any[]>([]);
  const [audienceType, setAudienceType] = useState<'all' | 'tags'>(prefillTags.length > 0 ? 'tags' : 'all');
  const [availableTags, setAvailableTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>(prefillTags);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      api.templates.list().then((res) => {
        setTemplates(res.items || []);
        if (res.items?.length > 0) setTemplateId(res.items[0].id);
      });
      api.contacts.tags().then((tags) => {
        setAvailableTags(tags || []);
      });
      if (prefillTags.length > 0) {
        setSelectedTags(prefillTags);
        setAudienceType('tags');
      }
    }
  }, [isOpen, prefillTags]);

  if (!isOpen) return null;

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (audienceType === 'tags' && selectedTags.length === 0) {
      setError('Please select at least one tag or choose "All Opted-in Contacts"');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const filter =
        audienceType === 'all'
          ? { all: true }
          : { tags: selectedTags };

      const created = await api.campaigns.create({
        name,
        channel,
        templateId: templateId || undefined,
        filter,
      });

      // Auto launch the created campaign in demo mode (spec §7.2)
      await api.campaigns.launch(created.id);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to create campaign');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'var(--accent-amber-light)',
                border: '1px solid var(--accent-amber-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Send size={20} color="#92400e" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Launch Broadcast Campaign</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Multi-channel bulk messaging dispatch (spec §6 & §7)</div>
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
              Campaign Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Diwali Offer — Delhi VIPs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Channel *
            </label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as any)}
              className="input-field"
            >
              <option value="whatsapp">WhatsApp Broadcast (Meta Cloud API)</option>
              <option value="email">Email Campaign (Amazon SES)</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Select Template
            </label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="input-field"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.channel})
                </option>
              ))}
            </select>
          </div>

          {/* Audience Selector (Spec §7.2.1) */}
          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Audience Targeting (spec §7.2)
            </label>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
              <button
                type="button"
                onClick={() => setAudienceType('all')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  border: audienceType === 'all' ? '2px solid var(--brand-blue)' : '1px solid var(--border-subtle)',
                  background: audienceType === 'all' ? 'var(--brand-blue-light)' : '#ffffff',
                  color: audienceType === 'all' ? 'var(--brand-blue)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                All Opted-in Contacts
              </button>
              <button
                type="button"
                onClick={() => setAudienceType('tags')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  border: audienceType === 'tags' ? '2px solid var(--brand-blue)' : '1px solid var(--border-subtle)',
                  background: audienceType === 'tags' ? 'var(--brand-blue-light)' : '#ffffff',
                  color: audienceType === 'tags' ? 'var(--brand-blue)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Target by Tags
              </button>
            </div>

            {audienceType === 'tags' && (
              <div style={{ padding: '12px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  Select Tags to Target (contacts bearing ALL selected tags will receive message):
                </div>
                {availableTags.length > 0 ? (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {availableTags.map((t) => {
                      const isSelected = selectedTags.includes(t.tag);
                      return (
                        <button
                          key={t.tag}
                          type="button"
                          onClick={() => toggleTag(t.tag)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 'var(--radius-pill)',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            border: isSelected ? '1px solid var(--brand-blue)' : '1px solid var(--border-subtle)',
                            background: isSelected ? 'var(--brand-blue)' : '#ffffff',
                            color: isSelected ? '#ffffff' : 'var(--text-secondary)',
                            cursor: 'pointer',
                            transition: 'all 0.1s ease',
                          }}
                        >
                          #{t.tag} ({t.count})
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    No tags found in CRM. Import contacts with tags first via CSV.
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Campaigns atomically reserve wallet balance and enqueue BullMQ jobs per recipient. Settlement occurs automatically upon provider delivery receipts.
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-emerald btn-lg"
            style={{ marginTop: '8px', width: '100%' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Launching Dispatch...
              </>
            ) : (
              'Launch Campaign Now'
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
