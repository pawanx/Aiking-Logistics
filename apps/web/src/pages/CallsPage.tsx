import React, { useState, useEffect } from 'react';
import {
  PhoneCall,
  RefreshCw,
  Clock,
  CheckCircle2,
  PhoneForwarded,
  MessageSquare,
  User,
  X,
  Sparkles,
  AlertTriangle,
  ArrowRight,
  Headphones,
  FileText,
  Tag,
} from 'lucide-react';
import { api } from '../api/client';
import { PlaceCallModal } from '../components/calls/PlaceCallModal';

export const CallsPage: React.FC = () => {
  const [calls, setCalls] = useState<any[]>([]);
  const [isPlaceOpen, setIsPlaceOpen] = useState(false);
  const [selectedCall, setSelectedCall] = useState<any | null>(null);
  const [callTurns, setCallTurns] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingTurns, setIsLoadingTurns] = useState(false);

  const fetchCalls = async () => {
    setIsLoading(true);
    try {
      const res = await api.calls.list();
      setCalls(res.items || []);
    } catch (err) {
      console.error('Failed to fetch calls:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCalls();
  }, []);

  const handleOpenTranscript = async (call: any) => {
    setSelectedCall(call);
    setIsLoadingTurns(true);
    try {
      const data = await api.calls.getTurns(call.id);
      setCallTurns(data.turns || call.transcript || []);
    } catch (err) {
      console.error('Failed to fetch call turns:', err);
      setCallTurns(call.transcript || []);
    } finally {
      setIsLoadingTurns(false);
    }
  };

  const renderPriorityBadge = (priority?: string) => {
    const p = (priority || 'medium').toLowerCase();
    switch (p) {
      case 'urgent':
        return (
          <span className="badge badge-rose" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 700 }}>
            <AlertTriangle size={11} />
            URGENT
          </span>
        );
      case 'high':
        return (
          <span className="badge badge-amber" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 700 }}>
            HIGH
          </span>
        );
      case 'low':
        return (
          <span className="badge" style={{ background: '#f1f5f9', color: '#475569', border: '1px solid #cbd5e1', fontWeight: 600 }}>
            LOW
          </span>
        );
      case 'medium':
      default:
        return (
          <span className="badge badge-blue" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: 600 }}>
            MEDIUM
          </span>
        );
    }
  };

  const renderSentimentPill = (sentiment?: string) => {
    const s = (sentiment || 'neutral').toLowerCase();
    if (s === 'positive') {
      return <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#15803d', background: '#dcfce7', padding: '2px 8px', borderRadius: '12px' }}>Positive</span>;
    }
    if (s === 'negative') {
      return <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#b91c1c', background: '#fee2e2', padding: '2px 8px', borderRadius: '12px' }}>Negative</span>;
    }
    return <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569', background: '#f1f5f9', padding: '2px 8px', borderRadius: '12px' }}>Neutral</span>;
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>Client Calls & AI Intelligence</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
            Plivo client connections with automatic call recording, Deepgram transcription, executive summary, next actions, and priority rating
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={fetchCalls} className="btn btn-secondary">
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
          <button onClick={() => setIsPlaceOpen(true)} className="btn btn-emerald">
            <PhoneCall size={16} />
            <span>Connect Client Call</span>
          </button>
        </div>
      </div>

      {/* Calls Table */}
      <div className="data-card" style={{ overflow: 'hidden' }}>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Client / Phone</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Duration</th>
                <th>AI Summary & Next Actions</th>
                <th>Initiated At</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {calls.length > 0 ? (
                calls.map((c) => {
                  const isCompleted = c.status === 'completed' || c.status === 'escalated';
                  const phone = c.toNumber || c.toPhone || '—';
                  const name = c.contactName || 'Client';
                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>
                          <PhoneForwarded size={14} color="#7c3aed" />
                          <span>{phone}</span>
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, marginTop: '2px' }}>
                          {name}
                        </div>
                      </td>

                      <td>
                        {renderPriorityBadge(c.priority)}
                      </td>

                      <td>
                        <span className={`badge ${isCompleted ? 'badge-emerald' : 'badge-amber'}`}>
                          {isCompleted ? <CheckCircle2 size={12} /> : <Clock size={12} />}
                          {c.status?.toUpperCase() || 'COMPLETED'}
                        </span>
                      </td>

                      <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {c.durationSeconds ? `${c.durationSeconds}s` : '64s'}
                      </td>

                      <td style={{ maxWidth: '340px' }}>
                        {c.summary ? (
                          <div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                              {c.summary}
                            </div>
                            {c.nextAction && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', color: '#4338ca', marginTop: '3px', fontWeight: 600 }}>
                                <ArrowRight size={11} />
                                <span>Next: {c.nextAction}</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            {c.objective || 'Processing transcript...'}
                          </div>
                        )}
                      </td>

                      <td style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        {new Date(c.createdAt).toLocaleString()}
                      </td>

                      <td style={{ textAlign: 'right' }}>
                        <button
                          onClick={() => handleOpenTranscript(c)}
                          className="btn btn-secondary btn-sm"
                          style={{ color: '#7c3aed', borderColor: '#ddd6fe', gap: '6px' }}
                        >
                          <Sparkles size={13} />
                          <span>View Details</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>
                    {isLoading ? 'Loading client calls...' : 'No client calls connected yet. Click "Connect Client Call" to start.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Transcript & AI Intelligence Drawer */}
      {selectedCall && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '680px' }}>
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '10px',
                    background: 'var(--accent-violet-light)',
                    border: '1px solid var(--accent-violet-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Sparkles size={20} color="#7c3aed" />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                    AI Call Analysis & Transcript
                  </h3>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Client: <strong style={{ color: 'var(--text-primary)' }}>{selectedCall.contactName || 'Client'}</strong> ({selectedCall.toNumber || selectedCall.toPhone})
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedCall(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Badges Bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 14px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700 }}>PRIORITY:</span>
                {renderPriorityBadge(selectedCall.priority)}
              </div>
              <div style={{ width: '1px', height: '16px', background: 'var(--border-subtle)' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700 }}>SENTIMENT:</span>
                {renderSentimentPill(selectedCall.sentiment)}
              </div>
              <div style={{ width: '1px', height: '16px', background: 'var(--border-subtle)' }} />
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Duration: <strong style={{ color: 'var(--text-primary)' }}>{selectedCall.durationSeconds || 64}s</strong>
              </div>
            </div>

            {/* AI Summary Card */}
            <div style={{ padding: '14px 16px', background: '#eff6ff', borderRadius: 'var(--radius-md)', border: '1px solid #bfdbfe', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', fontWeight: 800, color: '#1e40af', textTransform: 'uppercase', marginBottom: '6px' }}>
                <Sparkles size={14} color="#2563eb" />
                <span>Executive Summary</span>
              </div>
              <div style={{ color: '#1e293b', fontSize: '0.9rem', lineHeight: 1.55 }}>
                {selectedCall.summary || 'Summary is being processed from the call audio transcript.'}
              </div>
            </div>

            {/* Next Actions Card */}
            <div style={{ padding: '14px 16px', background: '#fdf4ff', borderRadius: 'var(--radius-md)', border: '1px solid #f0abfc', marginBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', fontWeight: 800, color: '#86198f', textTransform: 'uppercase', marginBottom: '6px' }}>
                <CheckCircle2 size={14} color="#a21caf" />
                <span>Action Items & Next Steps</span>
              </div>
              <div style={{ color: '#3b0764', fontSize: '0.9rem', fontWeight: 600 }}>
                {selectedCall.nextAction && selectedCall.nextAction !== 'None'
                  ? selectedCall.nextAction
                  : 'No manual follow-up required. Call concluded satisfactorily.'}
              </div>
            </div>

            {/* Turn by turn dialogue */}
            <div style={{ marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '10px' }}>
                <FileText size={14} />
                <span>Call Transcript Turns</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '280px', overflowY: 'auto', paddingRight: '6px' }}>
                {isLoadingTurns ? (
                  <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px' }}>Loading transcript turns...</div>
                ) : callTurns.length > 0 ? (
                  callTurns.map((turn, i) => {
                    const isAgent = turn.speaker === 'agent' || turn.role === 'assistant';
                    return (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          gap: '10px',
                          alignItems: 'flex-start',
                          flexDirection: isAgent ? 'row' : 'row-reverse',
                        }}
                      >
                        <div
                          style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            background: isAgent ? '#eff6ff' : '#ecfdf5',
                            border: isAgent ? '1px solid #bfdbfe' : '1px solid #a7f3d0',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {isAgent ? <Headphones size={14} color="#004e9f" /> : <User size={14} color="#166534" />}
                        </div>
                        <div
                          style={{
                            maxWidth: '78%',
                            padding: '10px 14px',
                            borderRadius: 'var(--radius-md)',
                            background: isAgent ? '#f8fafc' : '#f0fdf4',
                            border: isAgent ? '1px solid var(--border-subtle)' : '1px solid #bbf7d0',
                            fontSize: '0.85rem',
                            color: 'var(--text-primary)',
                            lineHeight: 1.45,
                          }}
                        >
                          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>
                            {isAgent ? 'Logistics Representative' : (selectedCall.contactName || 'Client')}
                          </div>
                          <div>{turn.text || turn.content}</div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px' }}>
                    Transcript is being synthesized from recorded audio.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Place Call Modal */}
      {isPlaceOpen && (
        <PlaceCallModal
          isOpen={isPlaceOpen}
          onClose={() => setIsPlaceOpen(false)}
          onSuccess={() => {
            fetchCalls();
            setIsPlaceOpen(false);
          }}
        />
      )}
    </div>
  );
};

