'use strict';

require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { handleMessage, getLeadsCSV } = require('./agent');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ── Helpers ──────────────────────────────────────────────────────────────────
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    }
  );
  if (!res.ok) console.error('WhatsApp send error:', await res.text());
}

async function sendInstagramOrFB(recipientId, text) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.META_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    }
  );
  if (!res.ok) console.error('IG/FB send error:', await res.text());
}

const MEDIA_REPLY = 'Por el momento no puedo interpretar archivos multimedia (imágenes, audios o videos). Por favor escríbeme en texto y con gusto te ayudo 🛞';

// ── Webhook verification (GET) ────────────────────────────────────────────────
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

// ── Incoming messages (POST) ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  if (!verifyMetaSignature(req)) {
    console.warn('Invalid signature — request ignored');
    return;
  }

  const body     = req.body;
  if (!body?.object) return;
  const platform = body.object;

  try {
    for (const entry of body.entry || []) {

      // ── WhatsApp ────────────────────────────────────────────────────────────
      if (platform === 'whatsapp_business_account') {
        for (const change of entry.changes || []) {
          const messages = change.value?.messages;
          if (!messages) continue;

          for (const msg of messages) {
            const userId = msg.from;

            if (msg.type === 'text') {
              const text = msg.text.body;
              console.log(`[WA] ${userId}: ${text}`);
              const reply = await handleMessage(userId, text, 'whatsapp');
              await sendWhatsApp(userId, reply);
              // Send service center location+photo when client confirms mounting
              if (/monte|montar|instala/i.test(text) && /centro de servicios|9710|bay#1/i.test(reply)) {
                await sendServiceCenterInfo(userId).catch(e => console.error('Service center info error:', e.message));
              }
            } else {
              console.log(`[WA] ${userId}: [${msg.type}]`);
              await sendWhatsApp(userId, MEDIA_REPLY);
            }
          }
        }
      }

      // ── Instagram DM & Facebook Messenger ──────────────────────────────────
      if (platform === 'instagram' || platform === 'page') {
        for (const messaging of entry.messaging || []) {
          const msg = messaging.message;
          if (!msg || msg.is_echo) continue;

          const userId = messaging.sender.id;
          const label  = platform === 'instagram' ? 'IG' : 'FB';

          if (msg.text) {
            console.log(`[${label}] ${userId}: ${msg.text}`);
            const reply = await handleMessage(userId, msg.text, platform);
            await sendInstagramOrFB(userId, reply);
          } else {
            console.log(`[${label}] ${userId}: [multimedia]`);
            await sendInstagramOrFB(userId, MEDIA_REPLY);
          }
        }
      }
    }
  } catch (err) {
    console.error('Handler error:', err);
  }
});

// ── Send service center location + photo when client chooses mount ───────────
async function sendServiceCenterInfo(to) {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const base = `https://graph.facebook.com/v19.0/${phoneId}`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // Send location
  await fetch(`${base}/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      messaging_product: 'whatsapp', to,
      type: 'location',
      location: {
        latitude: 25.876764,
        longitude: -80.355644,
        name: 'Tires Depot Service Center',
        address: '9710 NW 114 Way Bay#1, Medley FL 33178'
      }
    })
  });

  // Send photo of service center
  await fetch(`${base}/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      messaging_product: 'whatsapp', to,
      type: 'image',
      image: {
        link: 'https://tires-depot.com/wp-content/uploads/2026/05/Centro-de-Servicios-Tires-depot.jpeg',
        caption: '🔧 Tires Depot Service Center — 9710 NW 114 Way Bay#1, Medley FL 33178 | Lun-Vie 9am-5pm | Sáb 9am-1pm | Sin cita previa'
      }
    })
  });
}

// ── Leads CSV ─────────────────────────────────────────────────────────────────
app.get('/leads', (req, res) => {
  if (req.query.token !== process.env.META_VERIFY_TOKEN) return res.status(401).send('Unauthorized');
  const csv = getLeadsCSV();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => console.log(`Tires Depot Agent running on port ${PORT}`));
