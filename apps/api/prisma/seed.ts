/**
 * Database seed — creates essentials so you can test immediately.
 *
 * Usage: `npm run seed` (from the monorepo root)
 *
 * Idempotent: upserts on unique keys, so running it twice is safe.
 *
 * Creates:
 *   • A Super Admin user  (admin@aiking.example / admin123)
 *   • A demo tenant       (demo-logistics)
 *   • A Manager user      (manager@demo.example / demo123)
 *   • A Staff user        (staff@demo.example / demo123)
 *   • Default pricing rules for all 3 event types
 *   • A wallet with ₹500 onboarding free credits
 *   • 3 sample contacts with WhatsApp opt-in
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BCRYPT_ROUNDS = 10;

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://aiking:aiking@localhost:5432/aiking?schema=public';
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log('🌱 Seeding database…\n');

    // ── Super Admin ──────────────────────────────────────────────────────
    const adminHash = await bcrypt.hash('admin123', BCRYPT_ROUNDS);
    const admin = await prisma.user.upsert({
      where: { email: 'admin@aiking.example' },
      update: {},
      create: {
        email: 'admin@aiking.example',
        passwordHash: adminHash,
        fullName: 'Platform Admin',
        isSuperAdmin: true,
      },
    });
    console.log(`  ✅ Super Admin: ${admin.email} (id: ${admin.id})`);

    // ── Demo tenant ──────────────────────────────────────────────────────
    const tenant = await prisma.tenant.upsert({
      where: { slug: 'demo-logistics' },
      update: {},
      create: {
        name: 'Demo Logistics Co.',
        slug: 'demo-logistics',
        status: 'active',
        plan: 'standard',
        contactEmail: 'hello@demo-logistics.example',
        emailFromName: 'Demo Logistics',
        emailFromAddress: 'noreply@demo-logistics.example',
      },
    });
    console.log(`  ✅ Tenant: ${tenant.name} (slug: ${tenant.slug})`);

    // ── Manager user ─────────────────────────────────────────────────────
    const managerHash = await bcrypt.hash('demo123', BCRYPT_ROUNDS);
    const manager = await prisma.user.upsert({
      where: { email: 'manager@demo.example' },
      update: {},
      create: {
        email: 'manager@demo.example',
        passwordHash: managerHash,
        fullName: 'Demo Manager',
        isSuperAdmin: false,
      },
    });

    await prisma.tenantUser.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: manager.id } },
      update: {},
      create: {
        tenantId: tenant.id,
        userId: manager.id,
        role: 'manager',
        inviteStatus: 'active',
        acceptedAt: new Date(),
      },
    });
    console.log(`  ✅ Manager: ${manager.email}`);

    // ── Staff user ───────────────────────────────────────────────────────
    const staffHash = await bcrypt.hash('demo123', BCRYPT_ROUNDS);
    const staff = await prisma.user.upsert({
      where: { email: 'staff@demo.example' },
      update: {},
      create: {
        email: 'staff@demo.example',
        passwordHash: staffHash,
        fullName: 'Demo Staff',
        isSuperAdmin: false,
      },
    });

    await prisma.tenantUser.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: staff.id } },
      update: {},
      create: {
        tenantId: tenant.id,
        userId: staff.id,
        role: 'staff',
        inviteStatus: 'active',
        acceptedAt: new Date(),
      },
    });
    console.log(`  ✅ Staff: ${staff.email}`);

    // ── Wallet with free credits ─────────────────────────────────────────
    const freeCreditsPaise = BigInt(50_000); // ₹500.00
    const wallet = await prisma.wallet.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        balancePaise: BigInt(0),
        freeCreditBalancePaise: freeCreditsPaise,
        reservedPaise: BigInt(0),
        lifetimeCreditedPaise: freeCreditsPaise,
        lifetimeDebitedPaise: BigInt(0),
        currency: 'INR',
      },
    });
    console.log(`  ✅ Wallet: ₹${Number(wallet.freeCreditBalancePaise) / 100} free credits`);

    // ── Free credit ledger entry ─────────────────────────────────────────
    const idempotencyKey = `onboarding:${tenant.id}`;
    const existingTx = await prisma.walletTransaction.findUnique({
      where: { wallet_tx_tenant_idempotency: { tenantId: tenant.id, idempotencyKey } },
    });
    if (!existingTx) {
      await prisma.walletTransaction.create({
        data: {
          tenantId: tenant.id,
          type: 'free_credit_grant',
          bucket: 'free',
          amountPaise: freeCreditsPaise,
          balanceAfterPaise: freeCreditsPaise,
          description: 'Onboarding free credits (₹500.00)',
          referenceType: 'onboarding',
          referenceId: tenant.id,
          idempotencyKey,
          createdBy: admin.id,
        },
      });
      console.log(`  ✅ Ledger: free credit grant recorded`);
    }

    // ── Default pricing rules ────────────────────────────────────────────
    const pricingDefaults = [
      { eventType: 'whatsapp_message' as const, unitPricePaise: BigInt(85), label: 'WhatsApp ₹0.85/msg' },
      { eventType: 'email_message' as const, unitPricePaise: BigInt(12), label: 'Email ₹0.12/msg' },
      { eventType: 'ai_call_minute' as const, unitPricePaise: BigInt(650), label: 'AI Call ₹6.50/min' },
    ];

    for (const rule of pricingDefaults) {
      // Platform defaults have tenantId = NULL
      const existing = await prisma.pricingRule.findFirst({
        where: { tenantId: null, eventType: rule.eventType, active: true },
      });
      if (!existing) {
        await prisma.pricingRule.create({
          data: {
            tenantId: null,
            eventType: rule.eventType,
            unitPricePaise: rule.unitPricePaise,
            currency: 'INR',
            active: true,
            createdBy: admin.id,
          },
        });
        console.log(`  ✅ Pricing: ${rule.label}`);
      } else {
        console.log(`  ⏭️  Pricing: ${rule.label} (already exists)`);
      }
    }

    // ── Sample contacts ──────────────────────────────────────────────────
    const contacts = [
      { fullName: 'Priya Sharma', phone: '+919876543210', email: 'priya@example.com' },
      { fullName: 'Rahul Verma', phone: '+919876543211', email: 'rahul@example.com' },
      { fullName: 'Anita Desai', phone: '+919876543212', email: 'anita@example.com' },
    ];

    for (const c of contacts) {
      const existing = await prisma.contact.findUnique({
        where: { tenantId_phone: { tenantId: tenant.id, phone: c.phone } },
      });
      if (!existing) {
        await prisma.contact.create({
          data: {
            tenantId: tenant.id,
            fullName: c.fullName,
            phone: c.phone,
            email: c.email,
            whatsappOptedIn: true,
            emailOptedIn: true,
            tags: ['demo'],
            customFields: { region: 'Mumbai', tier: 'premium' },
          },
        });
        console.log(`  ✅ Contact: ${c.fullName}`);
      } else {
        console.log(`  ⏭️  Contact: ${c.fullName} (already exists)`);
      }
    }

    console.log('\n🎉 Seed complete!\n');
    console.log('  Logins available:');
    console.log('    Super Admin → admin@aiking.example / admin123');
    console.log('    Manager     → manager@demo.example / demo123 (tenant: demo-logistics)');
    console.log('    Staff       → staff@demo.example   / demo123 (tenant: demo-logistics)\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('❌ Seed failed:', error);
  process.exit(1);
});
