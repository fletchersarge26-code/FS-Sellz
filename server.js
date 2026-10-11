/**
 * FS.SELLS — Full-stack server
 * Express + Stripe (with demo-mode fallback) + file persistence
 * -------------------------------------------------------------
 * - Serves the storefront (public/ + root index.html)
 * - REST API for products, cart checkout, orders, admin
 * - Stripe Checkout (real payments when keys are set, mocked otherwise)
 * - Stock / price are always re-validated server-side
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;

// ── Config (mirrors CONFIG in the frontend) ──
const STORE = {
  storeName: process.env.STORE_NAME || 'FS.SELLS',
  currency: process.env.CURRENCY || '£',
  currencyCode: process.env.CURRENCY_CODE || 'gbp',
  shippingFlat: parseFloat(process.env.SHIPPING_FLAT || '12'),
  freeShippingOver: parseFloat(process.env.FREE_SHIPPING_OVER || '250'),
  orderEmail: process.env.ORDER_EMAIL || 'orders@fssells.com',
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'fs-sells-admin-2024';

// Stripe — lazy init so app runs without keys (demo mode)
let stripe = null;
let stripeReady = false;
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith('sk_')) {
  try {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    stripeReady = true;
    console.log('[stripe] live — secret key loaded');
  } catch (e) {
    console.warn('[stripe] failed to init:', e.message);
  }
} else {
  console.log('[stripe] demo mode — no STRIPE_SECRET_KEY, payments will be mocked');
}

// ── Data paths & helpers ──
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('readJson failed', file, e.message);
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Seed orders file if missing
if (!fs.existsSync(ORDERS_FILE)) writeJson(ORDERS_FILE, []);

let products = readJson(PRODUCTS_FILE, []);
if (!products.length) {
  // fallback inline seed (mirrors DEFAULT_PRODUCTS) — should not happen if data/products.json exists
  console.warn('[data] products.json empty or missing, seeding inline');
  products = [];
}

// ── Middleware ──
app.use(cors());

// Stripe webhook needs RAW body — must be before json parser
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripeReady) return res.json({ received: true, stripe: false });
  const sig = req.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) return res.json({ received: true, warning: 'No webhook secret configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (err) {
    console.error('[webhook] signature verify failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  console.log('[webhook] event', event.type);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orders = readJson(ORDERS_FILE, []);
    const idx = orders.findIndex((o) => o.stripeSessionId === session.id || o.id === session.id);
    if (idx !== -1) {
      orders[idx].status = 'paid';
      orders[idx].paidAt = new Date().toISOString();
      orders[idx].stripePaymentIntent = session.payment_intent;
      writeJson(ORDERS_FILE, orders);
      console.log(`[webhook] order ${orders[idx].id} marked paid`);
    } else {
      orders.unshift({
        id: session.id,
        createdAt: new Date().toISOString(),
        customer: { email: session.customer_email || session.customer_details?.email || '' },
        items: [],
        totals: { sub: (session.amount_subtotal || 0) / 100, ship: 0, total: (session.amount_total || 0) / 100 },
        currency: session.currency || STORE.currencyCode,
        status: 'paid',
        payment: 'stripe',
        stripeSessionId: session.id,
      });
      writeJson(ORDERS_FILE, orders.slice(0, 500));
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) console.log(`[api] ${req.method} ${req.path}`);
  next();
});

// ── Helpers ──
function totalsFor(items) {
  // items: [{id, qty}] — look up live prices from server store
  let sub = 0;
  const resolved = [];
  for (const it of items) {
    const p = products.find((x) => x.id === it.id);
    if (!p) throw new Error(`Unknown product: ${it.id}`);
    const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
    if (p.stock != null && qty > p.stock) {
      throw new Error(`Only ${p.stock} left for "${p.title}"`);
    }
    sub += p.price * qty;
    resolved.push({ id: p.id, title: p.title, price: p.price, qty, image: p.image, category: p.category });
  }
  const free = STORE.freeShippingOver > 0 && sub >= STORE.freeShippingOver;
  const ship = sub === 0 || free ? 0 : STORE.shippingFlat;
  return { sub, ship, total: sub + ship, free, resolved };
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token || (req.body && req.body.token);
  if (token && token === ADMIN_PASSWORD) return next();
  // also allow Authorization: Bearer <token>
  const auth = req.headers.authorization;
  if (auth && auth.replace(/^Bearer\s+/i, '') === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized — invalid admin token' });
}

// ── API: config / health ──
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, store: STORE.storeName, stripe: stripeReady ? 'live' : 'demo', products: products.length, time: new Date().toISOString() });
});

app.get('/api/config', (_req, res) => {
  res.json({
    storeName: STORE.storeName,
    currency: STORE.currency,
    currencyCode: STORE.currencyCode,
    shippingFlat: STORE.shippingFlat,
    freeShippingOver: STORE.freeShippingOver,
    orderEmail: STORE.orderEmail,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    stripeReady,
  });
});

// ── API: products ──
app.get('/api/products', (req, res) => {
  let out = [...products];
  const { category, search, q, sort, limit } = req.query;

  if (category && category !== 'All') out = out.filter((p) => p.category === category);
  const term = (search || q || '').toLowerCase().trim();
  if (term) {
    out = out.filter(
      (p) =>
        p.title.toLowerCase().includes(term) ||
        (p.category || '').toLowerCase().includes(term) ||
        (p.description || '').toLowerCase().includes(term) ||
        (p.badge || '').toLowerCase().includes(term)
    );
  }
  if (sort === 'price-asc') out.sort((a, b) => a.price - b.price);
  if (sort === 'price-desc') out.sort((a, b) => b.price - a.price);
  if (sort === 'newest') out.sort((a, b) => (b.id || '').localeCompare(a.id || ''));
  if (sort === 'name') out.sort((a, b) => a.title.localeCompare(b.title));

  if (limit) out = out.slice(0, Math.min(parseInt(limit, 10) || out.length, 100));

  res.json(out);
});

app.get('/api/products/:id', (req, res) => {
  const p = products.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json(p);
});

// Create
app.post('/api/products', requireAdmin, (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: 'title required' });
  const p = {
    id: b.id || 'p' + Date.now(),
    title: String(b.title).trim(),
    price: Math.max(0, parseFloat(b.price) || 0),
    category: String(b.category || 'Denim').trim() || 'Denim',
    badge: String(b.badge || '').trim(),
    image: String(b.image || '').trim(),
    description: String(b.description || '').trim(),
    paymentLink: String(b.paymentLink || '').trim(),
    stock: b.stock != null ? Math.max(0, parseInt(b.stock, 10) || 0) : 10,
  };
  if (products.some((x) => x.id === p.id)) return res.status(409).json({ error: 'id already exists' });
  products.push(p);
  writeJson(PRODUCTS_FILE, products);
  res.status(201).json(p);
});

// Bulk replace — used by the visual editor (admin panel)
app.put('/api/products', requireAdmin, (req, res) => {
  const arr = req.body.products || req.body;
  if (!Array.isArray(arr)) return res.status(400).json({ error: 'Expected array of products' });
  const next = [];
  for (const b of arr) {
    if (!b.title) continue;
    next.push({
      id: b.id || 'p' + Date.now() + Math.random().toString(36).slice(2, 6),
      title: String(b.title).trim().slice(0, 80),
      price: Math.max(0, parseFloat(b.price) || 0),
      category: String(b.category || 'Denim').trim() || 'Denim',
      badge: String(b.badge || '').trim().slice(0, 24),
      image: String(b.image || '').trim().slice(0, 4000),
      description: String(b.description || '').trim().slice(0, 400),
      paymentLink: String(b.paymentLink || '').trim().slice(0, 500),
      stock: b.stock != null ? Math.max(0, parseInt(b.stock, 10) || 0) : 10,
    });
  }
  products = next;
  writeJson(PRODUCTS_FILE, products);
  res.json({ ok: true, count: products.length, products });
});

// Update single
app.put('/api/products/:id', requireAdmin, (req, res) => {
  const idx = products.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  const p = products[idx];
  if (b.title != null) p.title = String(b.title).trim() || p.title;
  if (b.price != null) p.price = Math.max(0, parseFloat(b.price) || 0);
  if (b.category != null) p.category = String(b.category).trim() || p.category;
  if (b.badge != null) p.badge = String(b.badge).trim();
  if (b.image != null) p.image = String(b.image).trim();
  if (b.description != null) p.description = String(b.description).trim();
  if (b.paymentLink != null) p.paymentLink = String(b.paymentLink).trim();
  if (b.stock != null) p.stock = Math.max(0, parseInt(b.stock, 10) || 0);
  writeJson(PRODUCTS_FILE, products);
  res.json(p);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const idx = products.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = products.splice(idx, 1);
  writeJson(PRODUCTS_FILE, products);
  res.json({ ok: true, removed });
});

// ── API: checkout ──
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, customer } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty' });

    // Basic customer validation
    if (!customer || !customer.email || !String(customer.email).includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    if (!customer.name) return res.status(400).json({ error: 'Name required' });
    if (!customer.address) return res.status(400).json({ error: 'Address required' });

    const { sub, ship, total, resolved } = totalsFor(items);

    // If Stripe is not configured, run in demo/mock mode
    if (!stripeReady) {
      // Persist order as demo order
      const orders = readJson(ORDERS_FILE, []);
      const order = {
        id: 'FS-' + Date.now().toString().slice(-6),
        createdAt: new Date().toISOString(),
        customer,
        items: resolved,
        totals: { sub, ship, total },
        currency: STORE.currencyCode,
        status: 'demo',
        payment: 'mock',
      };
      orders.unshift(order);
      writeJson(ORDERS_FILE, orders.slice(0, 500));
      console.log(`[order][demo] ${order.id} — ${customer.email} — ${STORE.currency}${total.toFixed(2)} — ${resolved.length} items`);

      // Optionally decrement stock? In demo we don't, but we could log.
      return res.json({ demo: true, orderId: order.id });
    }

    // ── Real Stripe Checkout ──
    const line_items = resolved.map((it) => ({
      price_data: {
        currency: STORE.currencyCode,
        product_data: {
          name: it.title,
          description: it.category || 'Denim',
          images: it.image && it.image.startsWith('http') ? [it.image] : undefined,
        },
        unit_amount: Math.round(it.price * 100),
      },
      quantity: it.qty,
    }));

    if (ship > 0) {
      line_items.push({
        price_data: {
          currency: STORE.currencyCode,
          product_data: { name: 'Shipping' },
          unit_amount: Math.round(ship * 100),
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      customer_email: customer.email,
      shipping_address_collection: { allowed_countries: ['GB', 'US', 'CA', 'AU', 'DE', 'FR', 'NL', 'IE', 'ES', 'IT', 'SE', 'NO', 'DK', 'JP', 'NZ', 'SG'] },
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: false },
      success_url: `${FRONTEND_URL}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/?canceled=true`,
      metadata: {
        order_customer: JSON.stringify(customer).slice(0, 450),
      },
    });

    // Also persist a pending order (will be confirmed via webhook ideally)
    const orders = readJson(ORDERS_FILE, []);
    orders.unshift({
      id: session.id,
      createdAt: new Date().toISOString(),
      customer,
      items: resolved,
      totals: { sub, ship, total },
      currency: STORE.currencyCode,
      status: 'pending',
      payment: 'stripe',
      stripeSessionId: session.id,
    });
    writeJson(ORDERS_FILE, orders.slice(0, 500));

    console.log(`[stripe] session ${session.id} — ${customer.email} — ${STORE.currency}${total.toFixed(2)}`);
    res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('[checkout] error', err.message);
    // User-friendly message; don't leak internal details except stock/validation errors which are intentional
    if (err.message && (err.message.startsWith('Only ') || err.message.startsWith('Unknown product'))) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Checkout failed — ' + err.message });
  }
});

// Direct order creation (email/invoice flow / fallback)
app.post('/api/orders', (req, res) => {
  try {
    const { items, customer } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart empty' });
    if (!customer || !customer.email) return res.status(400).json({ error: 'Email required' });

    const { sub, ship, total, resolved } = totalsFor(items);
    const orders = readJson(ORDERS_FILE, []);
    const order = {
      id: 'FS-' + Date.now().toString().slice(-6),
      createdAt: new Date().toISOString(),
      customer,
      items: resolved,
      totals: { sub, ship, total },
      currency: STORE.currencyCode,
      status: 'received',
      payment: 'invoice',
    };
    orders.unshift(order);
    writeJson(ORDERS_FILE, orders.slice(0, 500));
    console.log(`[order][invoice] ${order.id} — ${customer.email} — ${STORE.currency}${total.toFixed(2)}`);
    res.status(201).json({ ok: true, order });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List orders (admin only)
app.get('/api/orders', requireAdmin, (_req, res) => {
  const orders = readJson(ORDERS_FILE, []);
  res.json(orders);
});

// Single order
app.get('/api/orders/:id', requireAdmin, (req, res) => {
  const orders = readJson(ORDERS_FILE, []);
  const o = orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

// Admin login — returns ok if password matches; frontend stores token in sessionStorage
app.post('/api/admin/login', (req, res) => {
  const { password, token } = req.body || {};
  const attempt = password || token || '';
  if (attempt === ADMIN_PASSWORD) {
    return res.json({ ok: true, token: ADMIN_PASSWORD });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// (webhook moved above json middleware)

// Newsletter (mock — store to orders file or just log)
app.post('/api/newsletter', (req, res) => {
  const email = (req.body && req.body.email || '').trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  console.log(`[newsletter] ${email}`);
  res.json({ ok: true });
});

// ── Static ──
// Prefer ./public if it exists (new structure), otherwise serve root for backwards compat
const PUBLIC_DIR = path.join(__dirname, 'public');
const hasPublic = fs.existsSync(PUBLIC_DIR) && fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));

if (hasPublic) {
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', etag: true }));
  // SPA fallback — serve index.html for non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
} else {
  // Serve files from project root (where the original index.html lives)
  app.use(express.static(__dirname, { maxAge: '1h', etag: true, index: 'index.html' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
  });
}

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  FS.SELLS — ${STORE.storeName}`);
  console.log(`  ▶ http://localhost:${PORT}  (also http://0.0.0.0:${PORT})`);
  console.log(`  ▸ API: /api/health, /api/products, /api/create-checkout-session`);
  console.log(`  ▸ Stripe: ${stripeReady ? 'LIVE (real cards)' : 'DEMO (no charge) — set STRIPE_SECRET_KEY to enable'}`);
  console.log(`  ▸ Admin password: ${ADMIN_PASSWORD === 'fs-sells-admin-2024' ? '(default — change in .env! —)' : '(custom)'}`);
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM — shutting down');
  process.exit(0);
});
