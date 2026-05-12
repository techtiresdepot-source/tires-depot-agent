'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Business rules ──────────────────────────────────────────────────────────
const BIZ = {
  taxRate: 0.07,
  mountStandard: 25,
  mountLarge: 35,
  largeSizePrefixes: ['385', '425'],
  valve: 5,
  mountDiscount: 5,
  freeDeliveryZone: 'Miami-Dade County',
  phone: '+1 (786) 518-5105',
  address: '12301 NW 116th Ave, Suite 106, Medley FL 33178',
  email: 'info@tires-depot.com',
  url: 'https://tires-depot.com/shop/',
  hours: 'Mon–Fri 8am–6pm | Sat 9am–3pm',
};

const FINANCE_OPTIONS = [
  { name: 'Snap Finance',           note: 'Aprobación en minutos, sin crédito requerido' },
  { name: 'Acima',                  note: 'Lease-to-own, sin score mínimo' },
  { name: 'American First Finance', note: 'Financiación flexible, sin depósito' },
  { name: 'Koalafi',                note: 'Aprobación rápida, sin crédito perfecto' },
];

const POSITION_KEYWORDS = {
  steer:    ['steer','direccion','dirección','delantera','front','steering','eje delantero'],
  traction: ['traction','traccion','tracción','drive','motriz','trasera','rear','eje trasero'],
  trailer:  ['trailer','remolque','all position','all-position','todas posiciones','todas'],
};

function normalizePosition(text) {
  const t = text.toLowerCase();
  for (const [key, kws] of Object.entries(POSITION_KEYWORDS)) {
    if (kws.some(k => t.includes(k))) return key;
  }
  return null;
}

// ── Lead logger ─────────────────────────────────────────────────────────────
const LOG_FILE = process.env.LEADS_LOG || '/tmp/leads.csv';

function ensureLogHeader() {
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'fecha,canal,telefono,nombre,email,consulta\n', 'utf8');
  }
}

function logLead({ platform, phone, name, email, query }) {
  try {
    ensureLogHeader();
    const clean = s => (s||'').replace(/,/g,' ').replace(/"/g,'').trim();
    const row = `"${new Date().toISOString()}","${clean(platform)}","${clean(phone)}","${clean(name)}","${clean(email)}","${clean(query).substring(0,120)}"\n`;
    fs.appendFileSync(LOG_FILE, row, 'utf8');
    console.log(`[LEAD] ${platform} | ${phone} | ${name} | ${email||'no email'} | ${query}`);
  } catch (e) {
    console.error('Lead log error:', e.message);
  }
}

function updateLeadEmail(phone, email) {
  try {
    ensureLogHeader();
    const content  = fs.readFileSync(LOG_FILE, 'utf8');
    const lines    = content.split('\n');
    let updated    = false;
    const newLines = lines.map(line => {
      if (line.includes(`"${phone}"`) && line.includes(',"",')) {
        updated = true;
        return line.replace('","",' , `","${email}",`);
      }
      return line;
    });
    if (updated) fs.writeFileSync(LOG_FILE, newLines.join('\n'), 'utf8');
    else {
      // Lead not yet in file — will be added when search happens
    }
  } catch (e) {
    console.error('Lead email update error:', e.message);
  }
}

// ── WooCommerce inventory ───────────────────────────────────────────────────
const WC_BASE = process.env.WC_STORE_URL || 'https://tires-depot.com';
const WC_KEY  = process.env.WC_CONSUMER_KEY;
const WC_SEC  = process.env.WC_CONSUMER_SECRET;
const cache   = { data: null, ts: 0, ttl: 5 * 60 * 1000 };

async function fetchAllInventory() {
  if (cache.data && Date.now() - cache.ts < cache.ttl) return cache.data;
  const auth = Buffer.from(`${WC_KEY}:${WC_SEC}`).toString('base64');
  const all  = [];
  let page   = 1;
  while (true) {
    const res   = await fetch(`${WC_BASE}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`WC API error: ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  cache.data = all.map(p => ({
    id:       p.id,
    name:     p.name,
    price:    parseFloat(p.price) || 0,
    stock:    p.stock_quantity ?? 0,
    inStock:  p.stock_status === 'instock',
    size:     attr(p,'tamaño') || attr(p,'size') || sizeFromName(p.name),
    brand:    attr(p,'marca')  || attr(p,'brand') || brandFromName(p.name),
    position: attr(p,'posicion') || attr(p,'position') || posFromName(p.name),
    type:     p.categories?.some(c => c.slug.includes('camion') || c.slug.includes('truck')) ? 'truck' : 'passenger',
  })).filter(p => p.inStock && p.price > 0);
  cache.ts = Date.now();
  return cache.data;
}

function attr(p, name) {
  const a = p.attributes?.find(x => x.name.toLowerCase().includes(name));
  return a?.options?.[0] || null;
}
function sizeFromName(n) {
  const m = n.match(/(\d{2,3}[\/R]\d{2}[\d.]*\w*|\d{2}R\d{2}\.?\d*)/i);
  return m ? m[0].toUpperCase() : null;
}
function brandFromName(n) {
  const brands = ['Royal Black','Dynastone','Falken','Firestone','Pirelli','Continental','Yokohama',
    'Headway','Sunfull','Westlake','Aplus','Speedmax','Driveforce','DRC','JK','Kelly','Lanvigator',
    'Ovation','Itaro','Tornado','Easymax','Jetway','Kobe','Dplus'];
  return brands.find(b => n.toLowerCase().includes(b.toLowerCase())) || '';
}
function posFromName(n) {
  const l = n.toLowerCase();
  if (l.includes('steer'))                            return 'steer';
  if (l.includes('traction') || l.includes('drive'))  return 'traction';
  if (l.includes('trailer'))                          return 'trailer';
  if (l.includes('all position'))                     return 'all position';
  return '';
}

function filterTires(size, position, brand) {
  let tires = cache.data || [];
  if (size) {
    const q = size.toLowerCase().replace(/[^a-z0-9]/g,'');
    tires = tires.filter(p => {
      const s  = (p.size||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      const nm = (p.name||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      return s===q || s.includes(q) || q.includes(s.substring(0,6)) || nm.includes(q);
    });
  }
  if (position) {
    const kws = POSITION_KEYWORDS[position] || [position];
    tires = tires.filter(p => {
      const pp = (p.position||'').toLowerCase();
      const pn = (p.name||'').toLowerCase();
      return kws.some(k => pp.includes(k) || pn.includes(k));
    });
  }
  if (brand) {
    const b = brand.toLowerCase();
    tires = tires.filter(p => (p.brand||'').toLowerCase().includes(b) || (p.name||'').toLowerCase().includes(b));
  }
  return tires.sort((a,b) => a.price - b.price);
}

function getMountCost(size) {
  const prefix = (size||'').replace(/\D.*/,'').substring(0,3);
  return BIZ.largeSizePrefixes.includes(prefix) ? BIZ.mountLarge : BIZ.mountStandard;
}

function calcTotal(tire, qty, withMount) {
  const tireT = tire.price * qty;
  const mc    = getMountCost(tire.size) * qty;
  const vc    = BIZ.valve * qty;
  const disc  = withMount ? BIZ.mountDiscount * qty : 0;
  const sub   = tireT + (withMount ? mc + vc - disc : 0);
  const tax   = sub * BIZ.taxRate;
  return { tireT, mc, vc, disc, sub, tax, grand: sub + tax };
}

function formatQuote(tire, qty, withMount) {
  const c   = calcTotal(tire, qty, withMount);
  const fmt = n => `$${n.toFixed(2)}`;
  const ml  = getMountCost(tire.size) === BIZ.mountLarge ? '$35/llanta (medida especial)' : '$25/llanta';
  const lines = [
    `🛞 *${qty}x ${tire.brand} ${tire.size}*`,
    `   ${tire.name}`,
    `   Llantas: ${fmt(c.tireT)}`,
  ];
  if (withMount) {
    lines.push(`   Monte (${ml}): ${fmt(c.mc)}`);
    lines.push(`   Válvulas ($5/c): ${fmt(c.vc)}`);
    lines.push(`   Dto. por montar con nosotros: -${fmt(c.disc)}`);
  }
  lines.push(`   Tax FL (7%): ${fmt(c.tax)}`);
  lines.push(`   ━━━━━━━━━━━━━━`);
  lines.push(`   *TOTAL: ${fmt(c.grand)}*`);
  lines.push(`🚚 Free delivery — Miami-Dade`);
  return lines.join('\n');
}

// ── Helpers to extract name, phone, email from free text ────────────────────
function extractName(text) {
  const t = text.trim();
  if (/\d|http|@/.test(t)) return null;
  const words = t.split(/\s+/);
  if (words.length >= 1 && words.length <= 4 && t.length <= 40) return t;
  return null;
}

function extractPhone(text) {
  const m = text.replace(/[\s\-().+]/g,'').match(/\d{10,15}/);
  return m ? m[0] : null;
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// ── Sessions ─────────────────────────────────────────────────────────────────
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      history:       [],
      tires:         [],
      size:          null,
      position:      null,
      brand:         null,
      // contact info
      name:          null,
      phone:         null,   // set automatically for WhatsApp
      email:         null,
      // flow state
      step:          'greeting',  // greeting → name → phone (non-WA) → searching → email_offer → done
      logged:        false,
      emailOffered:  false,
    });
  }
  return sessions.get(id);
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente virtual de ventas de Tires Depot, tienda de llantas para camiones y vehículos en Miami, FL.

DATOS DEL NEGOCIO:
- Dirección: ${BIZ.address}
- Teléfono: ${BIZ.phone}
- Email: ${BIZ.email}
- Horario: ${BIZ.hours}
- Free delivery en todo ${BIZ.freeDeliveryZone}

REGLAS DE PRECIOS:
- Tax FL: 7% sobre todo
- Monte: $${BIZ.mountStandard}/llanta estándar | $${BIZ.mountLarge}/llanta para medidas 385 y 425
- Válvula: $${BIZ.valve}/llanta
- Descuento: -$${BIZ.mountDiscount}/llanta al montar con nosotros (antes del tax)
- Free delivery en Miami-Dade. Otros condados tienen costo adicional.

FINANCIACIÓN:
${FINANCE_OPTIONS.map(f => `- ${f.name}: ${f.note}`).join('\n')}

FLUJO DE CONVERSACIÓN — sigue este orden estricto:

PASO 1 — SALUDO Y NOMBRE:
- Si no tienes [CUSTOMER NAME] → pide el nombre amigablemente al inicio

PASO 2 — TELÉFONO (solo si [NEEDS_PHONE]):
- Si ves [NEEDS_PHONE] en el contexto → pide el número de teléfono antes de continuar

PASO 3 — BÚSQUEDA DE LLANTAS:
- Si no tienes tamaño → pregúntalo
- Si tienes tamaño pero no posición (steer/traction/trailer/all position) → pregunta posición
- Con tamaño + posición → muestra TODOS los resultados de [INVENTORY DATA] en lista numerada
- Si piden "la más económica" → destaca la #1 (lista ordenada precio asc)
- Si mencionan marca → filtra por esa marca
- Cliente elige llanta → pregunta cuántas → muestra [QUOTE]

PASO 4 — OFERTA DE EMAIL (solo si [OFFER_EMAIL]):
- Después de mostrar cotización o resultados, si ves [OFFER_EMAIL] → invita al cliente a registrar su email para recibir la *Llanta de la Semana* con precios especiales. Hazlo de forma breve y no invasiva. Si dice que no → acepta y continúa normalmente.

FORMATO LISTA:
N. *Marca* — $precio/llanta | stock unidades | Posición | Monte $X/llanta
Después pregunta cuántas llantas necesita. Menciona free delivery Miami-Dade y -$5 por montar con nosotros.

ESTILO:
- Responde SIEMPRE en español por defecto. Solo cambia al inglés si el cliente escribe claramente en inglés.
- Mensajes cortos — formato WhatsApp/Instagram/Messenger
- Nunca inventes inventario — solo usa [INVENTORY DATA]
- Sin datos → invita a llamar al ${BIZ.phone}

Tags de contexto:
[CUSTOMER NAME: X] → ya tienes el nombre, no lo pidas
[CUSTOMER PHONE: X] → ya tienes el teléfono
[CUSTOMER EMAIL: X] → ya tienes el email
[NEEDS_PHONE] → pide el teléfono en este mensaje
[OFFER_EMAIL] → ofrece suscripción al email en este mensaje
[INVENTORY DATA: ...] → úsalo para mostrar opciones
[QUOTE: ...] → preséntalo como cotización final`;

// ── Main handler ──────────────────────────────────────────────────────────────
async function handleMessage(userId, incomingText, platform) {
  const session  = getSession(userId);
  const text     = incomingText.trim();
  const isWA     = platform === 'whatsapp';

  // WhatsApp: phone is the userId directly
  if (isWA && !session.phone) session.phone = userId;

  // ── Capture name if we asked last turn ───────────────────────────────────
  if (!session.name && session.step === 'name') {
    const extracted = extractName(text);
    if (extracted) {
      session.name = extracted;
      session.step = isWA ? 'searching' : 'phone';
    }
  }

  // ── Capture phone (non-WA) ───────────────────────────────────────────────
  if (!isWA && !session.phone && session.step === 'phone') {
    const extracted = extractPhone(text);
    if (extracted) {
      session.phone = extracted;
      session.step  = 'searching';
    }
  }

  // ── Capture email if offered ─────────────────────────────────────────────
  if (session.emailOffered && !session.email) {
    const extracted = extractEmail(text);
    if (extracted) {
      session.email = extracted;
      updateLeadEmail(session.phone || userId, session.email);
      console.log(`[EMAIL] ${session.name} | ${session.email}`);
    }
    // If customer declined (no/no gracias) just move on — Claude handles the reply
  }

  // ── Detect tire search params ─────────────────────────────────────────────
  const sizeMatch = text.match(/(\d{2,3}[\/\\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*|\d{2}[rR]\d{2}\.?\d*)/i);
  if (sizeMatch) { session.size = sizeMatch[0]; session.step = 'searching'; }

  const pos = normalizePosition(text);
  if (pos) session.position = pos;
  if (/all.?position|todas.?posicion/i.test(text)) session.position = 'trailer';

  const brands = ['Royal Black','Dynastone','Falken','Firestone','Pirelli','Continental','Yokohama',
    'Headway','Sunfull','Westlake','Aplus','Speedmax','Driveforce','DRC','JK','Kelly','Lanvigator',
    'Ovation','Itaro','Tornado','Easymax','Jetway','Kobe','Dplus'];
  const brandHit = brands.find(b => text.toLowerCase().includes(b.toLowerCase()));
  if (brandHit) session.brand = brandHit;

  const cheapest = /económic|econom|cheapest|más barat|barata|menor precio|precio.?más.?bajo/i.test(text);

  // ── Build context tags ────────────────────────────────────────────────────
  let contactContext = '';
  if (session.name)  contactContext += `\n[CUSTOMER NAME: ${session.name}]`;
  if (session.phone) contactContext += `\n[CUSTOMER PHONE: ${session.phone}]`;
  if (session.email) contactContext += `\n[CUSTOMER EMAIL: ${session.email}]`;

  // Ask for phone on non-WA channels once we have name
  let needsPhone = '';
  if (!isWA && session.name && !session.phone && session.step === 'phone') {
    needsPhone = '\n[NEEDS_PHONE]';
  }

  // ── Fetch inventory ───────────────────────────────────────────────────────
  let inventoryContext = '';
  if (session.size) {
    try {
      await fetchAllInventory();
      const tires = filterTires(session.size, session.position, session.brand);
      session.tires = tires;

      if (tires.length > 0) {
        const cheapLabel = cheapest ? ' — CLIENTE QUIERE LA MÁS ECONÓMICA, destaca la #1' : '';
        const list = tires.map((t,i) =>
          `${i+1}. *${t.brand}* — $${t.price}/llanta | ${t.stock} en stock | Posición: ${t.position||'N/A'} | Monte: $${getMountCost(t.size)}/c`
        ).join('\n');
        const posLabel   = session.position ? ` | Posición: ${session.position}` : ' | (sin filtro posición aún)';
        const brandLabel = session.brand    ? ` | Marca: ${session.brand}` : '';
        inventoryContext = `\n\n[INVENTORY DATA: ${tires.length} llanta(s) para ${session.size}${posLabel}${brandLabel}${cheapLabel}:\n${list}]`;

        // Log lead once we have name + search query
        if (!session.logged && session.name) {
          logLead({
            platform,
            phone: session.phone || userId,
            name:  session.name,
            email: session.email || '',
            query: `${session.size} ${session.position||''} ${session.brand||''}`.trim(),
          });
          session.logged = true;
        }
      } else {
        inventoryContext = `\n\n[INVENTORY DATA: Sin resultados para ${session.size}${session.position?' pos:'+session.position:''}${session.brand?' marca:'+session.brand:''}. Sugiere llamar al ${BIZ.phone}.]`;
      }
    } catch (err) {
      console.error('Inventory fetch error:', err.message);
      inventoryContext = `\n\n[INVENTORY DATA: Error al obtener inventario. Invita a llamar al ${BIZ.phone}.]`;
    }
  }

  // ── Build quote ───────────────────────────────────────────────────────────
  let quoteContext = '';
  const qtyMatch   = text.match(/\b([1-9][0-9]?)\s*(llantas?|tires?|ruedas?|unidades?|pcs?)?/i);
  const wantsQuote = /cuanto|precio|total|costo|quote|how much|desglose|calcul|cotiz/i.test(text);

  if (session.tires.length > 0 && (qtyMatch || wantsQuote)) {
    let tire = session.tires[0];
    const pickMatch = text.match(/(?:número?|opción|#|^)\s*([1-9][0-9]?)(?:\s|$)/i);
    if (pickMatch) {
      const idx = parseInt(pickMatch[1]) - 1;
      if (idx >= 0 && idx < session.tires.length) tire = session.tires[idx];
    }
    const qty   = qtyMatch ? parseInt(qtyMatch[1]) : 4;
    const mount = !/sin monte|without mount|no mount|solo llant/i.test(text);
    if (qty >= 1 && qty <= 24) {
      quoteContext = `\n\n[QUOTE:\n${formatQuote(tire, qty, mount)}]`;
    }
  }

  // ── Email offer — after first quote or inventory shown, once per session ──
  let emailOffer = '';
  if (!session.emailOffered && !session.email && session.name &&
      (quoteContext || (inventoryContext && session.tires.length > 0))) {
    emailOffer = '\n[OFFER_EMAIL]';
    session.emailOffered = true;
  }

  // ── Send to Claude ────────────────────────────────────────────────────────
  const userMessage = text + contactContext + needsPhone + inventoryContext + quoteContext + emailOffer;

  session.history.push({ role:'user', content: userMessage });
  if (session.history.length > 10) session.history = session.history.slice(-10);

  // First message — set step to ask for name
  if (session.history.length === 1 && !session.name) session.step = 'name';

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system:     SYSTEM_PROMPT,
    messages:   session.history,
  });

  const reply = response.content[0].text;
  session.history.push({ role:'assistant', content: reply });

  return reply;
}

// ── Leads CSV endpoint ────────────────────────────────────────────────────────
function getLeadsCSV() {
  try {
    ensureLogHeader();
    return fs.readFileSync(LOG_FILE, 'utf8');
  } catch (e) {
    return 'fecha,canal,telefono,nombre,email,consulta\n';
  }
}

module.exports = { handleMessage, getLeadsCSV, BIZ, FINANCE_OPTIONS };
