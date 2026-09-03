/**
 * Typed API Client for Aiking Logistics Web Portal.
 * Automatically manages Authorization header from localStorage.
 */

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('aiking_token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = data?.message || data?.error || 'An unexpected error occurred';
    const code = data?.code || 'ERROR';
    throw new ApiError(response.status, code, message, data?.details);
  }

  return data as T;
}

export const api = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: {
    login: (credentials: { email: string; password: string }) =>
      request<{
        accessToken: string;
        user: {
          id: string;
          email: string;
          fullName: string;
          role: string;
          tenantId: string | null;
          tenantName: string | null;
          isSuperAdmin: boolean;
        };
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      }),
  },

  // ── Tenants (Super Admin) ────────────────────────────────────────────────
  tenants: {
    list: async () => {
      const res = await request<any>('/tenants');
      if (Array.isArray(res)) return { items: res };
      if (res?.items) return res;
      return { items: [] };
    },
    get: (id: string) => request<any>(`/tenants/${id}`),
    current: () => request<any>('/tenants/current'),
    onboard: (data: {
      name: string;
      slug?: string;
      plan?: string;
      managerEmail: string;
      managerFullName: string;
      managerPassword?: string;
      freeCreditsPaise?: string;
    }) =>
      request<any>('/tenants', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    suspend: (id: string, reason?: string) =>
      request<any>(`/tenants/${id}/suspend`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || 'Administrative suspension' }),
      }),
    resume: (id: string) => request<any>(`/tenants/${id}/resume`, { method: 'POST' }),
  },

  // ── Contacts & CRM ────────────────────────────────────────────────────────
  contacts: {
    list: (params?: { page?: number; limit?: number; search?: string }) => {
      const q = new URLSearchParams();
      if (params?.page) q.set('page', params.page.toString());
      if (params?.limit) q.set('limit', params.limit.toString());
      if (params?.search) q.set('search', params.search);
      return request<{ items: any[]; page: { page: number; pageSize: number; totalItems: number; totalPages: number } }>(
        `/contacts${q.toString() ? `?${q.toString()}` : ''}`,
      );
    },
    get: (id: string) => request<any>(`/contacts/${id}`),
    getTimeline: async (id: string) => {
      const res = await request<any>(`/timeline/contact/${id}`);
      return { timeline: res.events || res.timeline || [] };
    },
    create: (data: {
      fullName: string;
      phone: string;
      email?: string;
      whatsappOptedIn?: boolean;
      emailOptedIn?: boolean;
      tags?: string[];
      customFields?: Record<string, unknown>;
    }) =>
      request<any>('/contacts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    import: (data: { csv: string; unknownColumnsAsCustomFields?: boolean }) =>
      request<{
        imported: number;
        updated: number;
        skipped: number;
        errors: Array<{ row: number; message: string }>;
      }>('/contacts/import', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    tags: () => request<Array<{ tag: string; count: number }>>('/contacts/tags'),
  },

  // ── 360° Timeline ─────────────────────────────────────────────────────────
  timeline: {
    forContact: (contactId: string) =>
      request<{ contact: any; events: any[]; page: any }>(`/timeline/contact/${contactId}`),
  },

  // ── Templates ─────────────────────────────────────────────────────────────
  templates: {
    list: () => request<{ items: any[]; page: any }>('/templates'),
    create: (data: { name: string; channel: string; language?: string; body: string; subject?: string }) =>
      request<any>('/templates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },

  // ── Campaigns ─────────────────────────────────────────────────────────────
  campaigns: {
    list: () => request<{ items: any[]; page: any }>('/campaigns'),
    get: (id: string) => request<any>(`/campaigns/${id}`),
    create: (data: {
      name: string;
      channel: string;
      templateId?: string;
      scheduledAt?: string;
      filter?: { tags?: string[]; all?: boolean };
      contactIds?: string[];
      variables?: Record<string, unknown>;
    }) =>
      request<any>('/campaigns', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    launch: (id: string) => request<any>(`/campaigns/${id}/launch`, { method: 'POST' }),
  },

  // ── AI Calls & Telephony ──────────────────────────────────────────────────
  calls: {
    list: () => request<{ items: any[]; page: any }>('/calls'),
    get: (id: string) => request<any>(`/calls/${id}`),
    getTurns: async (id: string) => {
      try {
        return await request<any>(`/calls/${id}/turns`);
      } catch {
        const call = await request<any>(`/calls/${id}`);
        return { turns: call?.turns || call?.transcript || [] };
      }
    },
    place: async (data: { contactId?: string; toPhone?: string; objective?: string; prompt?: string; scriptId?: string }) => {
      let contactId = data.contactId;
      if (!contactId && data.toPhone) {
        // Find or create contact for the phone number
        const existing = await api.contacts.list({ search: data.toPhone, limit: 1 });
        if (existing.items?.length > 0) {
          contactId = existing.items[0].id;
        } else {
          const created = await api.contacts.create({
            fullName: 'Direct Dial Contact',
            phone: data.toPhone,
          });
          contactId = created.id;
        }
      }

      return request<any>('/calls', {
        method: 'POST',
        body: JSON.stringify({
          contactId,
          objective: data.objective || data.prompt || 'Outbound customer confirmation',
          scriptId: data.scriptId,
        }),
      });
    },
  },

  // ── Wallet & Billing ──────────────────────────────────────────────────────
  wallet: {
    get: () =>
      request<{
        summary: any;
        transactions: any[];
      }>('/wallet'),
    getTenantWallet: (tenantId: string) =>
      request<{
        summary: any;
        transactions: any[];
        page?: any;
      }>(`/wallet/tenants/${tenantId}`),
    adjust: (data: { tenantId: string; amountPaise: string; reason: string; allowNegativeBalance?: boolean }) =>
      request<any>('/wallet/adjustments', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getEffectivePricing: () => request<Record<string, { paise: string; rupees: number; formatted: string }>>('/billing/pricing/effective'),
  },

  // ── Top-ups & Razorpay ────────────────────────────────────────────────────
  topups: {
    create: (amountPaise: string) =>
      request<{ orderId: string; razorpayOrderId: string; amount: any; mock: boolean; mockCapturePath?: string }>(
        '/billing/topups',
        {
          method: 'POST',
          body: JSON.stringify({ amountPaise }),
        },
      ),
    mockCapture: (orderId: string) =>
      request<{ razorpayPaymentId: string; duplicate: boolean }>(`/billing/topups/${orderId}/mock-capture`, {
        method: 'POST',
      }),
  },
};
