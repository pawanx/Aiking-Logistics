/**
 * Systematic API feature verification script.
 *
 * Tests the entire platform feature-by-feature against the running API:
 *   1. Auth — Super Admin login & token issuance
 *   2. Auth — Manager login & tenant context resolution
 *   3. Tenants — Super Admin listing all tenants
 *   4. Contacts — Manager querying and creating contacts
 *   5. Templates — Manager creating WhatsApp & Email templates
 *   6. Wallet — Manager viewing wallet balance and free credits ledger
 *   7. Pricing — Manager querying effective pricing rules
 *   8. Top-up — Manager creating a Razorpay top-up order & mock-capturing payment
 *   9. Calls — Manager triggering an outbound AI call (mock mode)
 *  10. Timeline — Manager querying unified 360° communication timeline
 */

const API_BASE = 'http://localhost:3001/api';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function req(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('\n🚀 ═══════════════════════════════════════════════════════════');
  console.log('   Aiking Logistics — Systematic Feature Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, extra = '') {
    if (condition) {
      console.log(`  ✅ ${name} ${extra}`);
      passed++;
    } else {
      console.error(`  ❌ ${name} ${extra}`);
      failed++;
    }
  }

  // ── 1. Super Admin Login ───────────────────────────────────────────────────
  console.log('📌 1. Testing Authentication (Super Admin)...');
  const adminLogin = await req('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@aiking.example', password: 'admin123' }),
  });
  assert('Super Admin login returns 200/201', adminLogin.status === 200 || adminLogin.status === 201, `(status: ${adminLogin.status})`);
  assert('Returns JWT accessToken', Boolean(adminLogin.data?.accessToken));
  assert('User is super admin', adminLogin.data?.user?.isSuperAdmin === true);
  const adminToken = adminLogin.data?.accessToken;

  // ── 2. Manager Login ───────────────────────────────────────────────────────
  console.log('\n📌 2. Testing Authentication (Tenant Manager)...');
  const mgrLogin = await req('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'manager@demo.example', password: 'demo123' }),
  });
  assert('Manager login returns 200/201', mgrLogin.status === 200 || mgrLogin.status === 201, `(status: ${mgrLogin.status})`);
  assert('Manager bound to demo tenant', mgrLogin.data?.user?.tenantName === 'Demo Logistics Co.');
  assert('Manager role is manager', mgrLogin.data?.user?.role === 'manager');
  const mgrToken = mgrLogin.data?.accessToken;

  // ── 3. Tenants Management (Super Admin) ────────────────────────────────────
  console.log('\n📌 3. Testing Tenants Management (Super Admin)...');
  const tenantsList = await req('/tenants', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert('Super Admin can list tenants (200)', tenantsList.status === 200);
  assert('Contains demo-logistics tenant', Array.isArray(tenantsList.data) && tenantsList.data.some(t => t.slug === 'demo-logistics'));

  // ── 4. Contacts CRM (Manager) ──────────────────────────────────────────────
  console.log('\n📌 4. Testing Contacts CRM (Manager)...');
  const contactsList = await req('/contacts', {
    headers: { Authorization: `Bearer ${mgrToken}` },
  });
  assert('Manager can list contacts (200)', contactsList.status === 200);
  assert('Has seeded contacts', Array.isArray(contactsList.data?.items) && contactsList.data.items.length >= 3);
  const firstContact = contactsList.data?.items?.[0];

  // Test creating a new contact with unique phone & email
  const uniqueTag = Date.now().toString().slice(-6);
  const createContact = await req('/contacts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      fullName: 'Vikram Mehta',
      phone: `+919999${uniqueTag}`,
      email: `vikram_${uniqueTag}@example.com`,
      whatsappOptedIn: true,
      emailOptedIn: true,
      tags: ['vip', 'enterprise'],
    }),
  });
  assert('Manager can create contact (201)', createContact.status === 201);
  assert('Created contact has correct name', createContact.data?.fullName === 'Vikram Mehta');

  // ── 5. Templates (Manager) ─────────────────────────────────────────────────
  console.log('\n📌 5. Testing Templates Management (Manager)...');
  const createTemplate = await req('/templates', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      name: `delivery_alert_${Date.now()}`,
      channel: 'whatsapp',
      language: 'en',
      body: 'Hi {{fullName}}, your delivery is arriving today.',
    }),
  });
  assert('Manager can create WhatsApp template (201)', createTemplate.status === 201);
  assert('Template has detected variables', Array.isArray(createTemplate.data?.variables) && createTemplate.data.variables.includes('fullName'));

  // Submit template for approval (spec §6.1 — auto-approved in mock mode)
  if (createTemplate.data?.id) {
    const submitTpl = await req(`/templates/${createTemplate.data.id}/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    assert('Template submitted & auto-approved in mock mode', submitTpl.status === 200 || submitTpl.status === 201);
  }

  // ── 6. Wallet & Ledger (Manager) ───────────────────────────────────────────
  console.log('\n📌 6. Testing Wallet & Ledger (Manager)...');
  const wallet = await req('/wallet', {
    headers: { Authorization: `Bearer ${mgrToken}` },
  });
  assert('Manager can view wallet (200)', wallet.status === 200);
  assert('Has promotional free credits balance', wallet.data?.summary?.freeCreditBalance?.rupees > 0);
  assert('Has ledger transactions', Array.isArray(wallet.data?.transactions) && wallet.data.transactions.length > 0);

  // ── 7. Pricing Rules (Manager) ─────────────────────────────────────
  console.log('\n📌 7. Testing Pricing Rules (Manager)...');
  const pricing = await req('/billing/pricing/effective', {
    headers: { Authorization: `Bearer ${mgrToken}` },
  });
  assert('Manager can view effective pricing (200)', pricing.status === 200);
  assert('Has whatsapp_message pricing', Boolean(pricing.data?.whatsapp_message));
  assert('Has ai_call_minute pricing', Boolean(pricing.data?.ai_call_minute));

  // ── 8. Razorpay Top-up & Capture (Manager) ─────────────────────────────────
  console.log('\n📌 8. Testing Razorpay Top-up Order & Mock Payment Capture...');
  const createTopup = await req('/billing/topups', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({ amountPaise: '10000' }), // ₹100.00
  });
  assert('Create topup order returns 201', createTopup.status === 201);
  assert('Has Razorpay order ID', Boolean(createTopup.data?.razorpayOrderId || createTopup.data?.orderId));
  const orderId = createTopup.data?.orderId;

  if (orderId) {
    const mockCapture = await req(`/billing/topups/${orderId}/mock-capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    assert('Mock capture payment returns 200/201', mockCapture.status === 200 || mockCapture.status === 201);

    // Give BullMQ provider-callback worker a moment to process the webhook
    await sleep(600);

    // Verify wallet balance updated
    const updatedWallet = await req('/wallet', {
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    assert('Wallet paid balance reflects topup', updatedWallet.data?.summary?.paidBalance?.rupees >= 100);
  }

  // ── 9. Calls Module (Client Call with Post-Call AI Intelligence) ─────────────
  console.log('\n📌 9. Testing Client Call Connect & AI Intelligence (Manager)...');
  // In mock telephony, phone numbers ending in 3-9 complete, record, transcribe, and summarize
  const clientCallContact = await req('/contacts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      fullName: 'Sunil Kumar',
      phone: `+919911${Date.now().toString().slice(-5)}5`,
      email: `sunil_${Date.now()}@example.com`,
    }),
  });
  const targetContact = clientCallContact.data || firstContact || createContact.data;

  const placeCall = await req('/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      contactId: targetContact?.id,
      objective: 'Confirm delivery address for package PKG-1234',
    }),
  });
  assert('Connecting client call returns 201', placeCall.status === 201, `(status: ${placeCall.status})`);
  assert('Call has queued status', placeCall.data?.status === 'queued');

  // Poll for BullMQ worker to process Plivo callbacks, STT transcription, and Gemini AI summarization
  let callDetail = null;
  for (let i = 0; i < 10; i++) {
    await sleep(600);
    callDetail = await req(`/calls/${placeCall.data?.id}`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    if (callDetail.data?.summary) break;
  }

  assert('Can fetch connected call details (200)', callDetail?.status === 200);
  assert('Call contains AI summary', typeof callDetail?.data?.summary === 'string' && callDetail.data.summary.length > 0);
  assert('Call contains next actions', typeof callDetail?.data?.nextAction === 'string' && callDetail.data.nextAction.length > 0);
  assert('Call contains valid priority (urgent/high/medium/low)', ['urgent', 'high', 'medium', 'low'].includes(callDetail?.data?.priority));

  // ── 10. Timeline (360° Contact Communication Log) ──────────────────────────
  console.log('\n📌 10. Testing Unified Communication Timeline...');
  if (targetContact?.id) {
    const timeline = await req(`/timeline/contact/${targetContact.id}`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    assert('Contact timeline returns 200', timeline.status === 200);
    assert('Timeline contains events', Array.isArray(timeline.data?.events) && timeline.data.events.length > 0);
  }

  // ── 11. CSV Feature: Contacts Bulk Import & Tag-targeted Campaign (Spec §7) ─
  console.log('\n📌 11. Testing CSV Feature (Spec §7 — Import Contacts & Tag-based Campaign)...');
  const sampleCsv = `fullName,phone,email,tags,whatsappOptedIn,city
Priya Sharma,9876543210,priya@example.com,vip;delhi,yes,Delhi
Rahul Verma,+919123456789,,lead,true,Mumbai
Ananya Bose,,ananya@example.com,newsletter,false,Kolkata`;

  const csvImport = await req('/contacts/import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      csv: sampleCsv,
      unknownColumnsAsCustomFields: true,
    }),
  });
  assert('CSV import returns 200/201 (spec §7.1)', csvImport.status === 200 || csvImport.status === 201);
  assert('CSV imported + updated count equals 3', (csvImport.data?.imported + csvImport.data?.updated) === 3);
  assert('CSV skipped is 0 on valid payload', csvImport.data?.skipped === 0);
  assert('CSV errors array is empty', Array.isArray(csvImport.data?.errors) && csvImport.data.errors.length === 0);

  // Partial success test with an invalid row (row 2 missing both phone and email)
  const badCsv = `fullName,phone,email,tags\nMissing Contact,,,invalid\nGood Contact,9876500001,good@example.com,vip;delhi`;
  const badImport = await req('/contacts/import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({ csv: badCsv }),
  });
  assert('Import with invalid row handles partial success', badImport.status === 200 || badImport.status === 201);
  assert('Invalid row was skipped', badImport.data?.skipped === 1);
  assert('Valid row was imported or updated', (badImport.data?.imported + badImport.data?.updated) >= 1);
  assert('Error contains row number 2', badImport.data?.errors?.some(e => e.row === 2));

  // Verify tags in CRM
  const tagsRes = await req('/contacts/tags', {
    headers: { Authorization: `Bearer ${mgrToken}` },
  });
  assert('Contacts tags returns 200', tagsRes.status === 200);
  assert('Tags include "vip"', Array.isArray(tagsRes.data) && tagsRes.data.some(t => t.tag === 'vip'));

  // Step 2 (spec §7.2): Target the newly imported segment with a broadcast campaign
  const csvCampaign = await req('/campaigns', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mgrToken}` },
    body: JSON.stringify({
      name: `VIP Offer Blast ${Date.now()}`,
      channel: 'whatsapp',
      templateId: createTemplate.data?.id,
      filter: { tags: ['vip'] },
    }),
  });
  assert('Create draft campaign targeting CSV tags returns 201 (spec §7.2.1)', csvCampaign.status === 201);
  const csvCampaignId = csvCampaign.data?.id;

  if (csvCampaignId) {
    const launchRes = await req(`/campaigns/${csvCampaignId}/launch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    assert('Launch campaign targeting CSV tags returns 200/201 (spec §7.2.2)', launchRes.status === 200 || launchRes.status === 201);
    assert('Launch status is QUEUED or COMPLETED', launchRes.data?.status === 'queued' || launchRes.data?.status === 'completed');
    assert('Targeted recipients bearing vip tag', launchRes.data?.queuedRecipients >= 1);
  }

  // ── Final Report ───────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`   Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
