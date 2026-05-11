# Tires Depot — Agent Setup Guide

## What this is

A Node.js server that:
1. Receives messages from WhatsApp Business, Instagram DM, and Facebook Messenger via Meta webhooks
2. Queries your WooCommerce inventory in real time
3. Calculates full price breakdowns (tires + mount + valves + tax)
4. Responds using Claude AI with your business rules
5. Handles financing inquiries, delivery questions, and location

---

## Step 1 — Deploy the server (Railway — free tier)

1. Create a free account at https://railway.app
2. Click **New Project → Deploy from GitHub repo**
3. Push this folder to a GitHub repo first:
   ```bash
   git init
   git add .
   git commit -m "Tires Depot agent"
   git remote add origin https://github.com/YOUR_USER/tires-depot-agent.git
   git push -u origin main
   ```
4. In Railway, select your repo → it auto-detects Node.js and runs `npm start`
5. Go to **Settings → Networking → Generate Domain** — you get a URL like:
   `https://tires-depot-agent-production.up.railway.app`

---

## Step 2 — Set environment variables in Railway

In Railway → your service → **Variables**, add each value from `.env.example`:

| Variable | Where to find it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `WC_CONSUMER_KEY` | WooCommerce → Settings → Advanced → REST API |
| `WC_CONSUMER_SECRET` | Same as above |
| `META_APP_SECRET` | developers.facebook.com → App → Settings → Basic |
| `META_VERIFY_TOKEN` | You choose any random string, e.g. `tires_depot_secret_2024` |
| `META_ACCESS_TOKEN` | Meta Business Suite → WhatsApp → API Setup |
| `WHATSAPP_PHONE_ID` | Meta Business Suite → WhatsApp → API Setup → Phone Number ID |

---

## Step 3 — Create Meta App and connect channels

### 3a. Create the app
1. Go to https://developers.facebook.com
2. **My Apps → Create App → Business**
3. Name it "Tires Depot Bot"

### 3b. Add WhatsApp
1. In your app dashboard → **Add Product → WhatsApp**
2. Connect your WhatsApp Business Account
3. Copy your **Phone Number ID** → paste in Railway as `WHATSAPP_PHONE_ID`
4. Copy the **Temporary Access Token** (or generate a permanent one) → `META_ACCESS_TOKEN`

### 3c. Configure the webhook
1. In your Meta App → **WhatsApp → Configuration → Webhook**
2. **Callback URL**: `https://YOUR-RAILWAY-URL.railway.app/webhook`
3. **Verify Token**: the same string you used for `META_VERIFY_TOKEN`
4. Click **Verify and Save**
5. Subscribe to: `messages`

### 3d. Add Instagram (optional)
1. In your Meta App → **Add Product → Messenger** (Instagram uses Messenger API)
2. Connect your Instagram Business account
3. Same webhook URL, subscribe to `messages` and `messaging_postbacks`

### 3e. Add Facebook Messenger (optional)
1. In your Meta App → **Messenger → Settings**
2. Connect your Facebook Page
3. Same webhook URL, subscribe to `messages`

---

## Step 4 — WooCommerce API keys

1. In WordPress Admin → **WooCommerce → Settings → Advanced → REST API**
2. Click **Add key**
3. Description: `Tires Depot Agent`
4. User: your admin user
5. Permissions: **Read**
6. Click **Generate API key**
7. Copy Consumer Key and Consumer Secret → paste in Railway variables

---

## Step 5 — Test it

Send a WhatsApp message to your business number:
```
235/85R16
```

The bot should respond with available inventory and pricing within 3–5 seconds.

---

## How the pricing works

For any tire size, the bot calculates:

```
(price × qty)
+ (mount cost × qty)      ← $25/tire standard, $35 for 385/425 sizes
+ (valve × qty)           ← $5/tire
- (discount × qty)        ← -$5/tire when mounting with us
= subtotal
+ (subtotal × 7%)         ← FL sales tax
= TOTAL
```

Free delivery for all Miami-Dade County orders.

---

## Financing partners

The bot knows about all 4 financing options:
- Snap Finance
- Acima  
- American First Finance
- Koalafi

When a customer asks about financing, the bot explains all options and mentions no credit is required.

---

## Conversation languages

The bot automatically responds in Spanish or English depending on what language the customer uses.

---

## Support

If you need help with the setup, contact your developer or reach out to:
- Anthropic docs: https://docs.anthropic.com
- Meta webhook docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- WooCommerce REST API: https://woocommerce.github.io/woocommerce-rest-api-docs
