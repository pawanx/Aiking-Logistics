import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users,
  Search,
  UserPlus,
  MessageSquare,
  Mail,
  ChevronRight,
  Phone,
  Tag,
  RefreshCw,
  FileSpreadsheet,
  Download,
  Filter,
  X,
} from 'lucide-react';
import { api } from '../api/client';
import { CreateContactModal } from '../components/contacts/CreateContactModal';
import { ImportContactsModal } from '../components/contacts/ImportContactsModal';

export const ContactsPage: React.FC = () => {
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const fetchContacts = async () => {
    setIsLoading(true);
    try {
      const res = await api.contacts.list({ search: search || undefined });
      setContacts(res.items || []);
    } catch (err) {
      console.error('Failed to fetch contacts:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchTags = async () => {
    try {
      const tags = await api.contacts.tags();
      setAvailableTags(tags || []);
    } catch (err) {
      console.error('Failed to fetch tags:', err);
    }
  };

  useEffect(() => {
    fetchContacts();
    fetchTags();
  }, [search]);

  // Client-side tag filtering
  const displayedContacts = selectedTag
    ? contacts.filter((c) => Array.isArray(c.tags) && c.tags.includes(selectedTag))
    : contacts;

  const handleExportCsv = () => {
    if (contacts.length === 0) return;
    const headers = ['fullName', 'phone', 'email', 'tags', 'whatsappOptedIn', 'emailOptedIn'];
    const rows = displayedContacts.map((c) => [
      `"${(c.fullName || '').replace(/"/g, '""')}"`,
      `"${c.phone || ''}"`,
      `"${c.email || ''}"`,
      `"${(c.tags || []).join(';')}"`,
      c.whatsappOptedIn ? 'true' : 'false',
      c.emailOptedIn ? 'true' : 'false',
    ]);
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `contacts_export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>Contacts CRM Directory</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
            Customer profiles, multi-channel opt-in permissions, and 360° interaction histories
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={() => { fetchContacts(); fetchTags(); }} className="btn btn-secondary" title="Refresh list">
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
          <button onClick={handleExportCsv} className="btn btn-secondary" title="Export displayed contacts to CSV">
            <Download size={16} />
            <span>Export CSV</span>
          </button>
          <button
            onClick={() => setIsImportOpen(true)}
            className="btn btn-secondary"
            style={{ borderColor: 'var(--brand-blue-border)', color: 'var(--brand-blue)', fontWeight: 600 }}
          >
            <FileSpreadsheet size={16} />
            <span>Import CSV</span>
          </button>
          <button onClick={() => setIsCreateOpen(true)} className="btn btn-primary">
            <UserPlus size={16} />
            <span>Add Contact</span>
          </button>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', minWidth: '320px', maxWidth: '440px', flex: 1 }}>
          <Search size={18} color="#64748b" style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)' }} />
          <input
            type="text"
            placeholder="Search by customer name, phone, or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field"
            style={{ paddingLeft: '42px' }}
          />
        </div>

        {/* Tag Filters */}
        {availableTags.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Filter size={14} /> Filter Tag:
            </span>
            {availableTags.slice(0, 8).map((t) => {
              const isSelected = selectedTag === t.tag;
              return (
                <button
                  key={t.tag}
                  onClick={() => setSelectedTag(isSelected ? null : t.tag)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 'var(--radius-pill)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    border: isSelected ? '1px solid var(--brand-blue)' : '1px solid var(--border-subtle)',
                    background: isSelected ? 'var(--brand-blue-light)' : '#ffffff',
                    color: isSelected ? 'var(--brand-blue)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    transition: 'all 0.1s ease',
                  }}
                >
                  <span>#{t.tag}</span>
                  <span style={{ opacity: 0.6, fontSize: '0.7rem' }}>({t.count})</span>
                  {isSelected && <X size={12} />}
                </button>
              );
            })}
            {selectedTag && (
              <button
                onClick={() => setSelectedTag(null)}
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '0.75rem', padding: '2px 6px' }}
              >
                Clear filter
              </button>
            )}
          </div>
        )}
      </div>

      {/* Contacts List / Table */}
      <div className="data-card" style={{ overflow: 'hidden' }}>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer Name</th>
                <th>Phone Number</th>
                <th>Email Address</th>
                <th>Channel Opt-ins</th>
                <th>Tags</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedContacts.length > 0 ? (
                displayedContacts.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/contacts/${c.id}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div
                          style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '50%',
                            background: '#eff6ff',
                            border: '1px solid #bfdbfe',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 700,
                            color: '#004e9f',
                            fontSize: '0.85rem',
                          }}
                        >
                          {c.fullName?.charAt(0) || 'C'}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{c.fullName}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>ID: {c.id?.slice(0, 8)}</div>
                        </div>
                      </div>
                    </td>

                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                        <Phone size={14} color="#64748b" />
                        <span>{c.phone || '—'}</span>
                      </div>
                    </td>

                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', color: c.email ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        <Mail size={14} color="#64748b" />
                        <span>{c.email || '—'}</span>
                      </div>
                    </td>

                    <td>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {c.whatsappOptedIn ? (
                          <span className="badge badge-emerald">
                            <MessageSquare size={11} /> WhatsApp
                          </span>
                        ) : (
                          <span className="badge badge-slate">WA Opt-out</span>
                        )}
                        {c.emailOptedIn ? (
                          <span className="badge badge-indigo">
                            <Mail size={11} /> Email
                          </span>
                        ) : (
                          <span className="badge badge-slate">Email Opt-out</span>
                        )}
                      </div>
                    </td>

                    <td>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {c.tags?.map((t: string) => (
                          <span
                            key={t}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedTag(t);
                            }}
                            className="badge badge-slate"
                            style={{ fontSize: '0.7rem', cursor: 'pointer' }}
                            title="Click to filter by tag"
                          >
                            #{t}
                          </span>
                        ))}
                      </div>
                    </td>

                    <td style={{ textAlign: 'right' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/contacts/${c.id}`);
                        }}
                        className="btn btn-ghost btn-sm"
                        style={{ color: '#004e9f', fontWeight: 700 }}
                      >
                        <span>360° Timeline</span>
                        <ChevronRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>
                    {isLoading ? 'Loading CRM contacts...' : 'No contacts matching your query'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Contact Modal */}
      {isCreateOpen && (
        <CreateContactModal
          isOpen={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          onSuccess={() => {
            fetchContacts();
            fetchTags();
            setIsCreateOpen(false);
          }}
        />
      )}

      {/* Import Contacts Modal (Spec Section 7) */}
      {isImportOpen && (
        <ImportContactsModal
          isOpen={isImportOpen}
          onClose={() => setIsImportOpen(false)}
          onSuccess={() => {
            fetchContacts();
            fetchTags();
          }}
          onLaunchCampaign={(tags) => {
            setIsImportOpen(false);
            navigate('/campaigns', { state: { prefillTags: tags } });
          }}
        />
      )}
    </div>
  );
};
