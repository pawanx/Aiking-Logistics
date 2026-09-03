import React, { useState, useEffect } from 'react';
import { FileText, Plus, MessageSquare, Mail, RefreshCw, Copy, Check } from 'lucide-react';
import { api } from '../api/client';
import { CreateTemplateModal } from '../components/templates/CreateTemplateModal';

export const TemplatesPage: React.FC = () => {
  const [templates, setTemplates] = useState<any[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchTemplates = async () => {
    setIsLoading(true);
    try {
      const res = await api.templates.list();
      setTemplates(res.items || []);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>Message Templates Library</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
            Pre-approved Meta WhatsApp Cloud API and Amazon SES email templates with dynamic variable substitutions
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={fetchTemplates} className="btn btn-secondary">
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
          <button onClick={() => setIsCreateOpen(true)} className="btn btn-primary">
            <Plus size={16} />
            <span>Create Template</span>
          </button>
        </div>
      </div>

      {/* Grid of Templates */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '22px' }}>
        {templates.map((tpl) => {
          const isWA = tpl.channel === 'whatsapp';
          return (
            <div key={tpl.id} className="data-card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`badge ${isWA ? 'badge-emerald' : 'badge-indigo'}`}>
                      {isWA ? <MessageSquare size={12} /> : <Mail size={12} />}
                      {tpl.channel?.toUpperCase()}
                    </span>
                    <span className="badge badge-slate">APPROVED</span>
                  </div>
                  <button
                    onClick={() => handleCopy(tpl.id, tpl.body)}
                    title="Copy Content"
                    className="btn btn-ghost btn-sm"
                    style={{ padding: '4px 8px' }}
                  >
                    {copiedId === tpl.id ? <Check size={14} color="#166534" /> : <Copy size={14} />}
                  </button>
                </div>

                <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '8px' }}>
                  {tpl.name}
                </h3>

                {tpl.subject && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 600 }}>
                    Subject: {tpl.subject}
                  </div>
                )}

                <div
                  style={{
                    padding: '14px',
                    background: '#f8fafc',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: '0.85rem',
                    color: 'var(--text-primary)',
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {tpl.body}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--border-subtle)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                <span>ID: {tpl.id?.slice(0, 12)}</span>
                <span>{new Date(tpl.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          );
        })}
      </div>

      {templates.length === 0 && !isLoading && (
        <div className="data-card" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
          No templates found. Click "Create Template" to design your first broadcast template!
        </div>
      )}

      {/* Create Modal */}
      {isCreateOpen && (
        <CreateTemplateModal
          isOpen={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          onSuccess={() => {
            fetchTemplates();
            setIsCreateOpen(false);
          }}
        />
      )}
    </div>
  );
};
