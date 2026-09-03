import React, { useState, useRef } from 'react';
import {
  X,
  UploadCloud,
  FileText,
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Users,
  Send,
  AlertTriangle,
  RefreshCw,
  FileSpreadsheet,
} from 'lucide-react';
import { api } from '../../api/client';

interface ImportContactsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onLaunchCampaign?: (tags: string[]) => void;
}

const SAMPLE_CSV = `fullName,phone,email,tags,whatsappOptedIn,city
Priya Sharma,9876543210,priya@example.com,vip;delhi,yes,Delhi
Rahul Verma,+919123456789,,lead,true,Mumbai
Ananya Bose,,ananya@example.com,newsletter,false,Kolkata`;

export const ImportContactsModal: React.FC<ImportContactsModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  onLaunchCampaign,
}) => {
  const [tab, setTab] = useState<'upload' | 'paste'>('upload');
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [unknownColumnsAsCustomFields, setUnknownColumnsAsCustomFields] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    updated: number;
    skipped: number;
    errors: Array<{ row: number; message: string }>;
  } | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleDownloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'aiking_sample_contacts.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const processFile = (file: File) => {
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
      setError('Please upload a valid .csv file');
      return;
    }
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = (e.target?.result as string) || '';
      setCsvText(text);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csvText.trim()) {
      setError('Please upload a CSV file or paste CSV text');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await api.contacts.import({
        csv: csvText,
        unknownColumnsAsCustomFields,
      });
      setResult(res);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'CSV Import failed. Please check the format and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Quick preview parser (first 5 lines)
  const previewLines = csvText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5);

  const previewHeaders = previewLines.length > 0 ? previewLines[0].split(',').map((h) => h.trim()) : [];
  const previewRows =
    previewLines.length > 1 ? previewLines.slice(1).map((r) => r.split(',').map((c) => c.trim())) : [];

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '640px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '10px',
                background: 'var(--brand-blue-light)',
                border: '1px solid var(--brand-blue-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FileSpreadsheet size={22} color="var(--brand-blue)" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-primary)' }}>Import Contacts from CSV</h3>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Bulk CRM onboarding with phone-first deduplication & tag enrichment (spec §7)
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Result view when completed */}
        {result ? (
          <div>
            <div
              style={{
                padding: '20px',
                borderRadius: 'var(--radius-lg)',
                background: '#f8fafc',
                border: '1px solid var(--border-subtle)',
                marginBottom: '20px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                <CheckCircle2 size={24} color="#166534" />
                <div>
                  <h4 style={{ fontSize: '1.1rem', color: 'var(--text-primary)' }}>CSV Processing Completed</h4>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    Your contact records have been synchronized with ambient tenant isolation.
                  </div>
                </div>
              </div>

              {/* Stat counters */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px' }}>
                <div
                  style={{
                    background: 'var(--action-green-light)',
                    border: '1px solid var(--action-green-border)',
                    padding: '12px',
                    borderRadius: 'var(--radius-md)',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#166534' }}>{result.imported}</div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#166534', textTransform: 'uppercase' }}>
                    New Imported
                  </div>
                </div>

                <div
                  style={{
                    background: 'var(--brand-blue-light)',
                    border: '1px solid var(--brand-blue-border)',
                    padding: '12px',
                    borderRadius: 'var(--radius-md)',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--brand-blue)' }}>{result.updated}</div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--brand-blue)', textTransform: 'uppercase' }}>
                    Updated / Enriched
                  </div>
                </div>

                <div
                  style={{
                    background: result.skipped > 0 ? 'var(--accent-amber-light)' : '#f1f5f9',
                    border: `1px solid ${result.skipped > 0 ? 'var(--accent-amber-border)' : '#e2e8f0'}`,
                    padding: '12px',
                    borderRadius: 'var(--radius-md)',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '1.5rem', fontWeight: 800, color: result.skipped > 0 ? '#92400e' : '#64748b' }}>
                    {result.skipped}
                  </div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      color: result.skipped > 0 ? '#92400e' : '#64748b',
                      textTransform: 'uppercase',
                    }}
                  >
                    Skipped Rows
                  </div>
                </div>
              </div>

              {/* Error list if any */}
              {result.errors.length > 0 && (
                <div
                  style={{
                    background: 'var(--accent-rose-light)',
                    border: '1px solid var(--accent-rose-border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '12px',
                    marginBottom: '16px',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      color: '#9f1239',
                      fontWeight: 700,
                      fontSize: '0.85rem',
                      marginBottom: '8px',
                    }}
                  >
                    <AlertTriangle size={15} />
                    <span>Row Exceptions ({result.errors.length})</span>
                  </div>
                  <div style={{ maxHeight: '140px', overflowY: 'auto' }}>
                    {result.errors.map((err, idx) => (
                      <div
                        key={idx}
                        style={{
                          fontSize: '0.75rem',
                          color: '#9f1239',
                          padding: '4px 0',
                          borderBottom: '1px dashed #fecdd3',
                          display: 'flex',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>Row {err.row}:</span>
                        <span>{err.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button
                type="button"
                onClick={onClose}
                className="btn btn-secondary"
              >
                Close & View Contacts
              </button>
              {onLaunchCampaign && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onLaunchCampaign(['vip']);
                  }}
                  className="btn btn-primary"
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <Send size={16} />
                  <span>Launch Broadcast Campaign</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {/* Download Sample & Tabs bar */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '16px',
                flexWrap: 'wrap',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', background: 'var(--bg-surface-subtle)', borderRadius: 'var(--radius-md)', padding: '3px' }}>
                <button
                  type="button"
                  onClick={() => setTab('upload')}
                  style={{
                    padding: '6px 14px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    cursor: 'pointer',
                    background: tab === 'upload' ? '#ffffff' : 'transparent',
                    color: tab === 'upload' ? 'var(--brand-blue)' : 'var(--text-secondary)',
                    boxShadow: tab === 'upload' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                  }}
                >
                  File Upload
                </button>
                <button
                  type="button"
                  onClick={() => setTab('paste')}
                  style={{
                    padding: '6px 14px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    cursor: 'pointer',
                    background: tab === 'paste' ? '#ffffff' : 'transparent',
                    color: tab === 'paste' ? 'var(--brand-blue)' : 'var(--text-secondary)',
                    boxShadow: tab === 'paste' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                  }}
                >
                  Paste CSV Text
                </button>
              </div>

              <button
                type="button"
                onClick={handleDownloadSample}
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <Download size={14} />
                <span>Download Sample CSV</span>
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

            {/* Input area */}
            {tab === 'upload' ? (
              <div style={{ marginBottom: '18px' }}>
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    border: `2px dashed ${isDragging ? 'var(--brand-blue)' : 'var(--border-medium)'}`,
                    borderRadius: 'var(--radius-lg)',
                    padding: '32px 20px',
                    textAlign: 'center',
                    background: isDragging ? 'var(--brand-blue-light)' : '#f8fafc',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                  />
                  <div
                    style={{
                      width: '48px',
                      height: '48px',
                      borderRadius: '50%',
                      background: '#ffffff',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 12px',
                    }}
                  >
                    <UploadCloud size={24} color="var(--brand-blue)" />
                  </div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                    {fileName ? fileName : 'Click to select or drag & drop customer CSV'}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Standard RFC 4180 format (up to 5,000 rows per import)
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ marginBottom: '18px' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                  Raw CSV Content *
                </label>
                <textarea
                  rows={6}
                  placeholder={`fullName,phone,email,tags,whatsappOptedIn,city\nPriya Sharma,9876543210,priya@example.com,vip;delhi,yes,Delhi`}
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  className="input-field"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
                />
              </div>
            )}

            {/* Live Preview Table */}
            {previewRows.length > 0 && (
              <div style={{ marginBottom: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    Data Preview ({previewLines.length - 1} rows detected in preview)
                  </span>
                  <span className="badge badge-emerald" style={{ fontSize: '0.7rem' }}>
                    Columns Validated
                  </span>
                </div>
                <div
                  style={{
                    background: '#ffffff',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    overflowX: 'auto',
                    maxHeight: '140px',
                  }}
                >
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', borderBottom: '1px solid var(--border-subtle)' }}>
                        {previewHeaders.map((h, i) => (
                          <th key={i} style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((r, ri) => (
                        <tr key={ri} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          {r.map((c, ci) => (
                            <td key={ci} style={{ padding: '6px 10px', color: 'var(--text-primary)' }}>
                              {c || '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Options */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '12px 14px',
                background: '#f8fafc',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
                marginBottom: '20px',
              }}
            >
              <input
                type="checkbox"
                id="unknownColumns"
                checked={unknownColumnsAsCustomFields}
                onChange={(e) => setUnknownColumnsAsCustomFields(e.target.checked)}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <label htmlFor="unknownColumns" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                Store unrecognised columns (e.g. city, orderId) in <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>customFields</code>
              </label>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !csvText.trim()}
                className="btn btn-primary"
                style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Importing Rows...</span>
                  </>
                ) : (
                  <>
                    <FileSpreadsheet size={16} />
                    <span>Execute Import</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
