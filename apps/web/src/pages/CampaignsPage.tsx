import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Send,
  Plus,
  RefreshCw,
  MessageSquare,
  Mail,
  CheckCircle2,
  Clock,
  BarChart3,
  Sparkles,
} from 'lucide-react';
import { api } from '../api/client';
import { CreateCampaignModal } from '../components/campaigns/CreateCampaignModal';

export const CampaignsPage: React.FC = () => {
  const location = useLocation();
  const prefillTags = (location.state as any)?.prefillTags as string[] | undefined;
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(Boolean(prefillTags && prefillTags.length > 0));
  const [isLoading, setIsLoading] = useState(true);

  const fetchCampaigns = async () => {
    setIsLoading(true);
    try {
      const res = await api.campaigns.list();
      setCampaigns(res.items || []);
    } catch (err) {
      console.error('Failed to fetch campaigns:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCampaigns();
  }, []);

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>Broadcast Campaigns</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
            Multi-channel broadcast messaging runs with asynchronous BullMQ delivery tracking
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={fetchCampaigns} className="btn btn-secondary">
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
          <button onClick={() => setIsCreateOpen(true)} className="btn btn-emerald">
            <Send size={16} />
            <span>Launch Campaign</span>
          </button>
        </div>
      </div>

      {/* Campaigns Table / Cards */}
      <div className="data-card" style={{ overflow: 'hidden' }}>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Campaign Name</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Audience / Progress</th>
                <th>Created At</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length > 0 ? (
                campaigns.map((c) => {
                  const isWA = c.channel === 'whatsapp';
                  const isCompleted = c.status === 'completed';
                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>ID: {c.id?.slice(0, 10)}</div>
                      </td>

                      <td>
                        <span className={`badge ${isWA ? 'badge-emerald' : 'badge-indigo'}`}>
                          {isWA ? <MessageSquare size={12} /> : <Mail size={12} />}
                          {c.channel?.toUpperCase()}
                        </span>
                      </td>

                      <td>
                        <span className={`badge ${isCompleted ? 'badge-emerald' : 'badge-amber'}`}>
                          {isCompleted ? <CheckCircle2 size={12} /> : <Clock size={12} />}
                          {c.status?.toUpperCase() || 'COMPLETED'}
                        </span>
                      </td>

                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {c.totalRecipients || 4} targeted
                          </div>
                          <span className="badge badge-slate" style={{ fontSize: '0.7rem' }}>
                            100% Processed
                          </span>
                        </div>
                      </td>

                      <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        {new Date(c.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>
                    {isLoading ? 'Loading campaigns...' : 'No broadcast campaigns recorded yet'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Modal */}
      {isCreateOpen && (
        <CreateCampaignModal
          isOpen={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          prefillTags={prefillTags}
          onSuccess={() => {
            fetchCampaigns();
            setIsCreateOpen(false);
          }}
        />
      )}
    </div>
  );
};
