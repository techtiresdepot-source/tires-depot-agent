'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Business rules ──────────────────────────────────────────────────────────
const BIZ = {
  taxRate: 0.07,
  mountStandard: 25,       // trucks standard
  mountLarge: 35,          // 385 and 425 sizes
  largeSizePrefixes: ['385', '425'],
  valve: 5,
  mountDiscount: 5,        // discount per tire when mounting with us
  freeDeliveryZone: 'Miami-Dade County',
  phone: '+1 (786) 518-5105',
  address: '12301 NW 116th Ave, Suite 106, Medley FL 33178',
  email: 'info@tires-depot.com',
  url: 'https://tires-depot.com/shop/',
  hours: 'Mon–Fri 8am–6pm | Sat 9am–3pm',
};

const FINANCE_OPTIONS = [
  { name: 'Snap Finance',           note: 'Approval in minutes, no credit required' },
  { name: 'Acima',                  note: 'Lease-to-own, no minimum credit score' },
  { name: 'American First Finance', note: 'Flexible financing, no deposit required' },
  { name: 'Koalafi',                note: 'Fast approval, no perfect credit needed' },
];

// ── WooCommerce inventory ───────────────────────────────────────────────────
const WC_BASE = process.env.WC_STORE_URL || 'https://tires-depot.com';
const WC_KEY  = process.env.WC_CONSUMER_KEY;
const WC_SEC  = process.env.WC_CONSUMER_SECRET;

const inventoryCache = { data: null, ts: 0, ttl: 5 * 60 * 1000 };

async function fetchInventory(sizeQuery) {
  const now = Date.now();

  // Return cached data if fresh
  if (inventoryCache.data && now - inventoryCache.ts < inventoryCache.ttl) {
    return filterBySize(inventoryCache.data, sizeQuery);
  }

  const auth = Buffer.from(`${WC_KEY}:${WC_SEC}`).toString('base64');
  const results = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `${WC_BASE}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!res.ok) throw new Error(`WC API error: ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    results.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  // Normalize products
  const normalized = results.map(p => ({
    id:       p.id,
    name:     p.name,
    price:    parseFloat(p.price) || 0,
    stock:    p.stock_quantity ?? 0,
    inStock:  p.stock_status === 'instock',
    size:     extractAttr(p, 'tamaño') || extractAttr(p, 'size') || extractSizeFromName(p.name),
    brand:    extractAttr(p, 'marca') || extractAttr(p, 'brand') || extractBrandFromName(p.name),
    position: extractAttr(p, 'position') || '',
    type:     p.categories?.some(c => c.slug.includes('camion') || c.slug.includes('truck')) ? 'truck' : 'passenger',
    url:      p.permalink,
  })).filter(p => p.inStock && p.price > 0);

  inventoryCache.data = normalized;
  inventoryCache.ts   = now;

  return filterBySize(normalized, sizeQuery);
}

function extractAttr(product, attrName) {
  const attr = product.attributes?.find(
    a => a.name.toLowerCase().includes(attrName.toLowerCase())
  );
  return attr?.options?.[0] || null;
}

function extractSizeFromName(name) {
  const m = name.match(/(\d{2,3}[\/R]\d{2}[\d.]*\w*|\d{2}R\d{2}\.?\d*|\d{2}x\d+\.?\d+R\d+)/i);
  return m ? m[0].toUpperCase() : null;
}

function extractBrandFromName(name) {
  const brands = ['Royal Black','Dynastone','Falken','Firestone','Pireli','Continental',
    'Yokohama','Headway','Sunfull','Westlake','Aplus','Speedmax','Driveforce','DRC',
    'JK','Kelly','Lanvigator','Ovation','Atlander','Advance','Cargomax','Hubtrac',
    'Itaro','Onyx','Rider','Tornado','American Builder'];
  return brands.find(b => name.toLowerCase().includes(b.toLowerCase())) || '';
}

function filterBySize(products, query) {
  if (!query) return products.slice(0, 10);
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '');
  return products.filter(p => {
    const s = (p.size || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const n = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return s === q || s.includes(q) || q.includes(s) || n.includes(q);
  });
}

function getMountCost(size) {
  const prefix = (size || '').replace(/[^0-9]/, '').substring(0, 3);
  return BIZ.largeSizePrefixes.includes(prefix) ? BIZ.mountLarge : BIZ.mountStandard;
}

function calcTotal(tire, qty, withMount) {
  const tireTotal  = tire.price * qty;
  const mountCost  = getMountCost(tire.size) * qty;
  const valveCost  = BIZ.valve * qty;
  const discount   = withMount ? BIZ.mountDiscount * qty : 0;
  const subtotal   = tireTotal + (withMount ? mountCost + valveCost - discount : 0);
  const tax        = subtotal * BIZ.taxRate;
  return { tireTotal, mountCost, valveCost, discount, subtotal, tax, grand: subtotal + tax };
}

function formatQuote(tire, qty, withMount) {
  const c   = calcTotal(tire, qty, withMount);
  const fmt = n => `$${n.toFixed(2)}`;
  const mountLabel = getMountCost(tire.size) === BIZ.mountLarge ? '$35/tire (special size)' : '$25/tire';
  let lines = [
    `🛞 *${qty}x ${tire.brand} ${tire.size}*`,
    `   Tires: ${fmt(c.tireTotal)}`,
  ];
  if (withMount) {
    lines.push(`   Mount (${mountLabel}): ${fmt(c.mountCost)}`);
    lines.push(`   Valves ($5/ea): ${fmt(c.valveCost)}`);
    lines.push(`   Discount (mount with us): -${fmt(c.discount)}`);
  }
  lines.push(`   FL Tax (7%): ${fmt(c.tax)}`);
  lines.push(`   ━━━━━━━━━━━━━━`);
  lines.push(`   *TOTAL: ${fmt(c.grand)}*`);
  lines.push(`🚚 Free delivery — Miami-Dade`);
  return lines.join('\n');
}

// ── Conversation state per user ─────────────────────────────────────────────
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { history: [], pendingTires: [], lastQuery: null });
  }
  return sessions.get(userId);
}

// ── Main AI handler ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the virtual sales assistant for Tires Depot, a truck and vehicle tire shop in Miami, FL.

BUSINESS INFO:
- Address: ${BIZ.address}
- Phone: ${BIZ.phone}
- Email: ${BIZ.email}
- Hours: ${BIZ.hours}
- Free delivery: all of ${BIZ.freeDeliveryZone}

PRICING RULES (always apply these exactly):
- FL Sales Tax: 7% on everything
- Mount cost: $${BIZ.mountStandard}/tire for standard truck tires | $${BIZ.mountLarge}/tire for 385 and 425 sizes
- Valve: $${BIZ.valve}/tire
- Discount: -$${BIZ.mountDiscount}/tire when customer mounts with us (subtract before tax)
- Free delivery within Miami-Dade. Other counties have extra delivery charge.

FINANCING PARTNERS (no credit required options available):
${FINANCE_OPTIONS.map(f => `- ${f.name}: ${f.note}`).join('\n')}

RESPONSE STYLE:
- Always respond in the same language as the customer (Spanish or English)
- Be friendly, concise, professional
- When a tire size is mentioned, acknowledge you are checking live inventory
- When showing prices always show the full breakdown: tires + mount + valves - discount + tax = total
- Always mention free delivery for Miami-Dade
- If customer is outside Miami-Dade, say delivery cost depends on zone
- For financing, mention all 4 options and say approval takes minutes
- Never make up inventory — only report what the INVENTORY DATA tool provides
- Keep messages short enough for WhatsApp/Instagram/Messenger

When you receive [INVENTORY: ...] in the conversation, that is live data from the website. Use it to answer.
When no inventory data is available for a size, say you are checking and will confirm shortly, or invite them to call/WhatsApp directly.`;

async function handleMessage(userId, incomingText, platform) {
  const session = getSession(userId);

  // Check if message contains a tire size — fetch inventory first
  const sizeMatch = incomingText.match(
    /(\d{2,3}[\/\\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*|\d{2}[rR]\d{2}\.?\d*|\d{2,3}x[\d.]+[rR]\d+)/i
  );

  let inventoryContext = '';
  if (sizeMatch) {
    try {
      const tires = await fetchInventory(sizeMatch[0]);
      session.pendingTires = tires;
      session.lastQuery    = sizeMatch[0];

      if (tires.length > 0) {
        const lines = tires.slice(0, 5).map(t =>
          `${t.brand} ${t.size} — ${t.name.replace(t.size, '').trim()} | Price: $${t.price} | Stock: ${t.stock} units | Type: ${t.type} | Mount cost: $${getMountCost(t.size)}/tire`
        ).join('\n');
        inventoryContext = `\n\n[INVENTORY: Found ${tires.length} matching tire(s) for size ${sizeMatch[0]}:\n${lines}]`;
      } else {
        inventoryContext = `\n\n[INVENTORY: No tires found for size ${sizeMatch[0]}. Available sizes in stock include: 11R22.5, 295/75R22.5, 315/80R22.5, 385/65R22.5, 425/65R22.5, 225/55ZR17, 245/70R16 and more.]`;
      }
    } catch (err) {
      console.error('Inventory fetch error:', err.message);
      inventoryContext = `\n\n[INVENTORY: Could not fetch live data. Advise customer to call ${BIZ.phone} for exact availability.]`;
    }
  }

  // If customer asks for a quote and we have pending tires, build it
  const wantsQuote = /cuanto|precio|total|costo|quote|how much|breakdown|desglose/i.test(incomingText);
  let quoteContext = '';
  if (wantsQuote && session.pendingTires.length > 0) {
    const t    = session.pendingTires[0];
    const qty  = parseInt(incomingText.match(/\d+/)?.[0]) || 4;
    const mount = !/sin monte|without mount|no mount|solo llant/i.test(incomingText);
    quoteContext = `\n\n[QUOTE CALCULATED:\n${formatQuote(t, qty, mount)}]`;
  }

  // Build message with context
  const userMessage = incomingText + inventoryContext + quoteContext;

  // Add to history
  session.history.push({ role: 'user', content: userMessage });

  // Keep history to last 10 messages to optimize token usage (~50% cost reduction)
  if (session.history.length > 10) {
    session.history = session.history.slice(-10);
  }

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 350,
    system:     SYSTEM_PROMPT,
    messages:   session.history,
  });

  const reply = response.content[0].text;

  // Add assistant reply to history
  session.history.push({ role: 'assistant', content: reply });

  return reply;
}

module.exports = { handleMessage, BIZ, FINANCE_OPTIONS };
