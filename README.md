# Aiking Logistics — Multi-Tenant AI Communication Platform

A modern, enterprise-grade multi-tenant platform for **automated customer communications**, **WhatsApp campaign broadcasts**, and **Plivo client calling with post-call AI intelligence** (Executive Summaries, Next Action Items, Priority Tiers, and Sentiment Analysis).

---

## ⚡ Quick Start for Local Development & Testing

Follow these steps to clone, set up, and run the entire platform locally on your machine in under **3 minutes**.

### 1. Prerequisites
- **Node.js**: `v20.11+` (Check with `node -v`)
- **Docker Desktop**: For local PostgreSQL & Redis (or use any cloud Postgres like Neon.tech)

---

### 2. Setup (3 Commands)

```bash
# 1. Clone the repository
git clone https://github.com/pawanx/Aiking-Logistics.git
cd Aiking-Logistics

# 2. Copy the zero-credential environment file
cp .env.example .env
# On Windows PowerShell:
# Copy-Item .env.example .env

# 3. Install dependencies and build shared libraries
npm install
npm run build
```

---

### 3. Start Database & Redis

Start local PostgreSQL and Redis with Docker Compose:

```bash
npm run infra:up
```

> **Note**: If you don't have Docker installed, simply paste a free cloud PostgreSQL connection string (e.g. from [Neon.tech](https://neon.tech)) into `.env` under `DATABASE_URL`, and set `QUEUE_DRIVER=inline` (no Redis required).

---

### 4. Initialize Database Schema & Seed Demo Data

```bash
npm run prisma:push
npm run seed
```

This sets up all tables, ledger rules, WhatsApp templates, and seeds the **Demo Logistics** tenant.

---

### 5. Launch Application

Start the backend API, BullMQ worker queue, and the frontend web portal in parallel:

```bash
npm run dev
```

The services will be active at:
- 🌐 **Web Portal**: [http://localhost:3000](http://localhost:3000)
- 🔌 **REST API**: [http://localhost:3001/api](http://localhost:3001/api)
- 📖 **Swagger API Docs**: [http://localhost:3001/api/docs](http://localhost:3001/api/docs)

---

## 🔑 Demo Test Accounts

Log in to the web portal at **[http://localhost:3000](http://localhost:3000)** using seeded credentials:

| Role | Email | Password | Access / Capabilities |
|:---|:---|:---|:---|
| **Tenant Manager** | `manager@demologistics.com` | `Manager@123` | Contacts CRM, CSV Import, WhatsApp Campaigns, Plivo Client Calls & AI Drawer, Wallet & Pricing |
| **Super Admin** | `admin@aiking.com` | `Admin@123` | Platform oversight, Tenant Management, Global Ledger & Pricing overrides |

---

## 🧪 Run Automated Verification Tests

Run the complete 47-assertion end-to-end integration test suite:

```bash
node scripts/test-api.mjs
```

This automatically validates:
1. Super Admin & Tenant Manager Authentication
2. Contacts CRM & Contact Creation
3. WhatsApp Template Detection & Auto-approval
4. Razorpay Mock Payment & Wallet Balance Credits
5. **Plivo Client Call Connect & Post-Call AI Intelligence** (Summary, Action Items, Priority Tier)
6. 360° Communication Timeline
7. **CSV Bulk Import & Tag-based Campaign Targeting**

---

## 📁 Project Structure

```text
Aiking-Logistics/
├── apps/
│   ├── api/             # NestJS API, BullMQ queue workers, Prisma ORM, AI Providers
│   └── web/             # React 18 + Vite SPA, Tailwind/CSS design system, CRM portal
├── packages/
│   └── shared/          # Shared TypeScript contracts, DTOs, Enums, Money math
├── docs/
│   ├── TECHNICAL_DOCUMENTATION.md  # Comprehensive engineering architecture specification
│   ├── TECHNICAL_DOCUMENTATION.pdf # Compiled vector PDF architecture document
│   └── USER_GUIDE.md               # User manual for portal navigation
├── scripts/
│   ├── dev.mjs          # Multi-process parallel dev runner
│   ├── test-api.mjs     # 47-point end-to-end automated test suite
│   └── generate-pdf.mjs # Markdown to PDF vector compilation script
└── docker-compose.infra.yml # Local Postgres & Redis definitions
```
