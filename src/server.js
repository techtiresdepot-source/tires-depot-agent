'use strict';

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { handleMessage, getLeadsCSV } = require('./agent');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Raw body needed for signature verification ──────────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ── Helpers ─────────────────────────────────────────────────────────────────
function verifyMetaSignature(req) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function sendWhatsApp(to, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error('WhatsApp send error:', err);
  }
}

async function sendInstagramOrFB(recipientId, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.META_ACCESS_TOKEN}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message:   { text },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error('IG/FB send error:', err);
  }
}

// ── Webhook verification (GET) ───────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Webhook verified ✓');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── Incoming messages (POST) ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  if (!verifyMetaSignature(req)) {
    console.warn('Invalid signature — request ignored');
    return;
  }

  const body = req.body;
  if (!body?.object) return;

  const platform = body.object; // 'whatsapp_business_account' | 'instagram' | 'page'

  try {
    for (const entry of body.entry || []) {
      // ── WhatsApp ──────────────────────────────────────────────────────────
      if (platform === 'whatsapp_business_account') {
        for (const change of entry.changes || []) {
          const messages = change.value?.messages;
          if (!messages) continue;
          for (const msg of messages) {
            if (msg.type !== 'text') continue;
            const userId = msg.from;
            const text   = msg.text.body;
            console.log(`[WA] ${userId}: ${text}`);
            const reply  = await handleMessage(userId, text, 'whatsapp');
            await sendWhatsApp(userId, reply);
          }
        }
      }

      // ── Instagram DM & Facebook Messenger ────────────────────────────────
      if (platform === 'instagram' || platform === 'page') {
        for (const messaging of entry.messaging || []) {
          const msg = messaging.message;
          if (!msg || msg.is_echo) continue;
          if (!msg.text) continue;

          const userId   = messaging.sender.id;
          const text     = msg.text;
          const label    = platform === 'instagram' ? 'IG' : 'FB';
          console.log(`[${label}] ${userId}: ${text}`);
          const reply    = await handleMessage(userId, text, platform);
          await sendInstagramOrFB(userId, reply);
        }
      }
    }
  } catch (err) {
    console.error('Handler error:', err);
  }
});

// ── Leads CSV download ────────────────────────────────────────────────────────
// Access: https://your-url.railway.app/leads?token=tires_depot_webhook_2024
app.get('/leads', (req, res) => {
  if (req.query.token !== process.env.META_VERIFY_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  const csv = getLeadsCSV();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Tires Depot Agent running on port ${PORT}`);
});
