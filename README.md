# FS.SELLS — Designer Denim

Curated designer denim, authenticated and sold in limited runs.  
**Now a fully functioning full-stack store** — Express API, Stripe Checkout, persistent catalogue and orders, admin editor, search / sort / wishlist, and a shop that works in demo or live-payment mode.

![FS.SELLS](https://img.shields.io/badge/store-FS.SELLS-1a2033) ![Node](https://img.shields.io/badge/node-%3E%3D18-339933) ![Stripe](https://img.shields.io/badge/payments-Stripe-635bff) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

Live preview (when server is running): `http://localhost:3000`

---

## ✨ What “fully functioning” means here

| Feature | How it works |
|---|---|
| **Live catalogue** | `GET /api/products` serves `data/products.json` (file-backed, no DB required). Search, category filter, and sort are done server- and client-side. |
| **Cart & wishlist** | Cart in `localStorage` + server-side price/stock re-validation on every checkout. Wishlist (heart) also in `localStorage`. |
| **Shipping math** | Flat £12, free over £250 — calculated on the **server** (`totalsFor()`) so the client can’t spoof it. |
| **Checkout** | `POST /api/create-checkout-session` → **Stripe Checkout** when `STRIPE_SECRET_KEY` is set, otherwise mocked “demo” mode. Stripe line-items are built from the server’s catalogue, not the client payload. |
| **Orders** | Every successful checkout is written to `data/orders.json` (demo, invoice, or pending Stripe). Admin can list them at `GET /api/orders`. Stripe webhook at `POST /api/webhook` marks paid orders when you wire it up. |
| **Admin editor** | The sliders button → password gate (`ADMIN_PASSWORD`) → visual editor (title, price, category, badge, image URL or upload-as-base64, description, Stripe Payment Link, stock). `PUT /api/products` bulk-saves to disk. Also exports a `DEFAULT_PRODUCTS` snippet for static builds. |
| **Newsletter** | `POST /api/newsletter` (logged server-side; drop in your ESP later). |
| **Resilience** | If the API is unreachable the frontend falls back to `localStorage` / `DEFAULT_PRODUCTS`, so the shop never whitescreens. Toasts surface every success/error. `?success=true` / `?canceled=true` from Stripe redirect are handled. |
| **Deployable** | One command: `npm start` serves the API **and** the static storefront on `0.0.0.0:$PORT`. No build step. Works on Render, Railway, Fly, Vercel (as a Node function), anywhere Node runs. |

---

## 🚀 Quick start

```bash
# 1. Clone & install
git clone https://github.com/fletchersarge26-code/FS-Sellz.git
cd FS-Sellz
npm install

# 2. Configure (optional — runs in demo mode without it)
cp .env.example .env
# edit .env — most importantly ADMIN_PASSWORD and, when ready, STRIPE_SECRET_KEY

# 3. Run
npm start          # http://localhost:3000
npm run dev        # --watch mode for hacking
```

No `.env`? No problem — Stripe stays in **demo mode** (no card charged, orders still recorded as `status: "demo"`).

---

## 🔑 Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | |
| `FRONTEND_URL` | no | `http://localhost:$PORT` | Used for Stripe `success_url` / `cancel_url` — set to your live domain in prod. |
| `ADMIN_PASSWORD` | **yes in prod** | `fs-sells-admin-2024` | Password for the editor & `GET /api/orders`. Also the `X-Admin-Token` header value. |
| `STRIPE_SECRET_KEY` | no | — | `sk_test_…` / `sk_live_…`. Empty ⇒ demo mode. |
| `STRIPE_WEBHOOK_SECRET` | no | — | `whsec_…` from `stripe webhook` setup. |
| `STRIPE_PUBLISHABLE_KEY` | no | — | Exposed to the browser via `GET /api/config` (safe). |
| `STORE_NAME` etc | no | FS.SELLS / £ / gbp / 12 / 250 | Currency, shipping. |

---

## 💳 Stripe — turning on real payments

**Test mode (no real money):**

1. Create a free account at https://dashboard.stripe.com/test/apikeys
2. Copy `Publishable key` → `STRIPE_PUBLISHABLE_KEY` and `Secret key` → `STRIPE_SECRET_KEY` into `.env`
3. Restart the server → logs say `[stripe] live — secret key loaded`
4. Checkout now redirects to `https://checkout.stripe.com/...` — use card `4242 4242 4242 4242` to test.

**Webhook (optional but recommended for reliable “paid” status):**

```bash
# install Stripe CLI, then
stripe login
stripe listen --forward-to localhost:3000/api/webhook
# copy the whsec_… it prints → STRIPE_WEBHOOK_SECRET
```

Without a webhook, the order is stored as `pending`; it’ll still appear in the admin’s Orders list. With a webhook, it’s marked `paid` on `checkout.session.completed`.

**Per-product Buy Now links:** In the admin editor you can paste a Stripe Payment Link per product — the quick-view then shows a second “Buy now” button.

---

## 📁 Project shape

```
FS-Sellz/
├── server.js           # Express — API + static serving + Stripe + file persistence
├── public/index.html   # Storefront (also copied to ./index.html for GitHub Pages)
├── index.html          # Same storefront at root (kept for backwards-compat)
├── data/
│   ├── products.json   # Source of truth — edited by admin or by hand
│   └── orders.json     # Append-only — created on first order (git-ignored)
├── package.json
├── .env.example
└── .env                # local only, not committed
```

---

## 🔌 API reference

```
GET  /api/health                      # { ok, store, stripe: "live"|"demo", products, time }
GET  /api/config                      # public store config + stripeReady
GET  /api/products?category=&search=&sort=&limit=
GET  /api/products/:id
POST /api/products            🔒      # { title, price, ... }
PUT  /api/products            🔒      # bulk replace — { products: [...] } or raw array
PUT  /api/products/:id        🔒
DELETE /api/products/:id      🔒
POST /api/create-checkout-session    # { items:[{id,qty}], customer:{name,email,address,city,postcode,country,phone?} } → { demo, orderId } | { url }
POST /api/orders                     # invoice/email flow — same body sans totals
GET  /api/orders              🔒      # list newest first
GET  /api/orders/:id          🔒
POST /api/admin/login                # { password } → { ok, token }
POST /api/newsletter                 # { email }
POST /api/webhook                    # Stripe — raw body, signature-checked
```

`🔒` = requires `X-Admin-Token: <ADMIN_PASSWORD>` or `Authorization: Bearer <ADMIN_PASSWORD>`.

Try it:

```bash
curl http://localhost:3000/api/products | jq .
curl http://localhost:3000/api/health | jq .

# checkout in demo mode
curl -X POST http://localhost:3000/api/create-checkout-session \
  -H "Content-Type: application/json" \
  -d '{"items":[{"id":"p1","qty":1}],"customer":{"name":"Ava","email":"ava@test.co","address":"1 High St","city":"London","postcode":"E1 6AN","country":"UK"}}' | jq .
```

---

## 🛠 Admin

Click the sliders icon in the header.

1. Password prompt (default `fs-sells-admin-2024`) — stored in `sessionStorage`, sent as `X-Admin-Token`.
2. Edit titles, prices, `category` (creates filters automatically), badge, image URL **or** upload from device (stored as `data:` URI — keep under ~900 kB or host it and paste the URL), description, Stripe Payment Link, stock.
3. **Add product / Delete / Reset to file defaults / Export code / Save changes.**
4. **Orders** appear underneath the editor once you’ve taken a few checkouts (newest first, with totals and status).

`Save changes` does `PUT /api/products` — the file on disk is updated, so saves survive restarts and are seen by all visitors. If the API is unreachable it falls back to `localStorage` and toasts a warning.

---

## 🎨 Frontend notes

* No bundler. Single HTML file, vanilla JS — fast to fork and keep hacking.
* Paper/indigo/selvedge design system via CSS variables (`--paper`, `--ink`, `--rust` …).
* The original `CONFIG` / `DEFAULT_PRODUCTS` block is still there for static-hosting fallback. When the API is reachable it’s overridden by `GET /api/config` + `GET /api/products`.
* Search (`#searchInput`) + sort (`#sortSelect`) + wishlist heart on every card. Stock is shown when low (`≤3` in red).
* Toasts (`#toastStack`) for every user action. Checkout errors are shown inline in the form plus as toasts. Newsletter uses `POST /api/newsletter`.
* The hero product card is clickable, as is every product card (quick-view modal). Bag drawer shows free-shipping progress.
* Admin, cart, and checkout are accessible via keyboard (`Esc` to close) and respect `prefers-reduced-motion`.

---

## 🚢 Deploy

**Render / Railway / Fly / Heroku / VPS**

```
Build:  npm install
Start:  npm start
Env:    PORT (set by platform), STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_PASSWORD, FRONTEND_URL
Health check: /api/health
```

**Vercel**

Set Framework preset to “Other”, Build: `npm install`, Output: `public`, Install: `npm install`, Start: `node server.js` (or convert `server.js` to a Vercel Function if you prefer).

**Static-only (GitHub Pages / Netlify static / S3)**

Just publish `index.html` — it still works fully offline via `localStorage` and demo checkout. You lose shared persistence and Stripe until you add a backend.

---

## 🧪 Scripts

```bash
npm start        # serve on 0.0.0.0:$PORT
npm run dev      # same with --watch (Node 18+)
```

`scripts/seed.js` (optional) — re-seeds `data/products.json` from the file’s `DEFAULT_PRODUCTS`.

---

## 📝 License

MIT — do what you want, credit appreciated.
