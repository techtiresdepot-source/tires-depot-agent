'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const { google } = require('googleapis');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Business rules ──────────────────────────────────────────────────────────
const BIZ = {
  taxRate: 0.07,
  mountStandard: 25,
  mountLarge: 35,
  largeSizePrefixes: ['385', '425'],
  valve: 5,           // optional — only if stem is worn/oxidized
  disposal: 10,        // optional — tire disposal when mounting with us
  creditSurcharge: 0.03, // 3% surcharge for credit card payments
  cashDiscount: false,   // no cash discount
  mountDiscount: 5,
  freeDeliveryZone: 'área de Miami',
  phone: '+1 (786) 518-5105',  // internal only — do not share in chat
  contactChannel: 'WhatsApp chat',
  address: '12301 NW 116th Ave, Suite 106, Medley FL 33178',
  email: 'info@tires-depot.com',
  url: 'https://tires-depot.com/shop/',
  hours: 'Lun–Vie 9am–5pm | Sáb 9am–1pm',
};

const FINANCE_OPTIONS = [
  { name: 'Snap Finance',           note: 'Aprobación en minutos, sin crédito requerido' },
  { name: 'Acima',                  note: 'Lease-to-own, sin score mínimo' },
  { name: 'American First Finance', note: 'Financiación flexible, sin depósito' },
  { name: 'Koalafi',                note: 'Aprobación rápida, sin crédito perfecto' },
];

const POSITION_KEYWORDS = {
  steer:        ['steer','direccion','dirección','delantera','front','steering','eje delantero'],
  traction:     ['traction','traccion','tracción','drive','motriz','trasera','rear','eje trasero'],
  trailer:      ['trailer','remolque','todas posiciones'],
  'all position': ['all position','all-position','todas','multi','universal'],
};

// Map session position key → exact WooCommerce attribute value
const POSITION_WC_VALUE = {
  steer:          'Steer',
  traction:       'Traction',
  trailer:        'Trailer',
  'all position': 'All Position',
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

// ── Google Sheets conversation logger ───────────────────────────────────────
const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = 'Conversaciones';

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key:  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function ensureSheetHeaders() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1:G1`,
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_TAB}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['fecha','canal','telefono','nombre','mensaje_cliente','respuesta_agente']] },
      });
    }
  } catch (e) {
    console.error('Sheet header error:', e.message);
  }
}

// Initialize headers on startup
ensureSheetHeaders().catch(() => {});

async function logConversation({ platform, phone, name, userMsg, agentReply }) {
  try {
    const sheets = await getSheetsClient();
    const row = [
      new Date().toISOString(),
      platform || '',
      phone    || '',
      name     || '',
      (userMsg    || '').substring(0, 500),
      (agentReply || '').substring(0, 500),
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:F`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  } catch (e) {
    console.error('Sheet log error:', e.message);
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
    size:     attr(p,'tamano') || attr(p,'tamaño') || sizeFromName(p.name),
    brand:    attr(p,'marca') || brandFromName(p.name),
    position: attr(p,'position') || posFromName(p.name),
    type:     p.categories?.some(c => c.slug.includes('camion') || c.slug.includes('truck')) ? 'truck' : 'passenger',
  })).filter(p => p.inStock && p.price > 0);
  cache.ts = Date.now();
  return cache.data;
}

function attr(p, name) {
  // Match attribute name ignoring accents, case and spaces
  const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  const target = normalize(name);
  const a = p.attributes?.find(x => normalize(x.name).includes(target) || normalize(x.slug||'').includes(target));
  return a?.options?.[0] || null;
}
function sizeFromName(n) {
  // Last resort: extract size from product name when attribute not present
  // Handles: 215/60R16, 215-60R16, 11R22.5
  const m = n.match(/(\d{2,3}[-\/]\d{2,3}[-\/R]\d{2}[\w.]*|\d{2}R\d{2}\.?\d*)/i);
  return m ? m[0].replace(/(\d{2,3})-(\d{2,3})-(\d{2})/i, '$1/$2R$3')
               .replace(/(\d{2,3}\/\d{2,3})\/(\d{2})/i, '$1R$2')
               .toUpperCase() : null;
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

function normalizeSize(s) {
  // First fix slash-only format: 235/85/16 → 235/85R16
  let v = (s||'').toUpperCase()
    .replace(/(\d{2,3})[\/\-](\d{2,3})[\/](\d{2})/g, '$1/$2R$3'); // 235/85/16 → 235/85R16
  // Then strip all non-alphanumeric
  return v.replace(/[^A-Z0-9]/g,'');
}

function filterTires(size, position, brand, origin) {
  let tires = cache.data || [];
  if (size) {
    const q = normalizeSize(size);
    tires = tires.filter(p => {
      // Primary: compare against WooCommerce size attribute (most reliable)
      const attrSize = normalizeSize(p.size);
      // Secondary: search in full product name (fallback)
      const nm = normalizeSize(p.name);
      return attrSize === q || nm.includes(q);
    });
  }
  if (position) {
    // Use WC position attribute as primary, fallback to name keywords
    const kws = POSITION_KEYWORDS[position] || [position];
    tires = tires.filter(p => {
      const pp = (p.position||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
      const pn = (p.name||'').toLowerCase();
      return kws.some(k => pp.includes(k) || pn.includes(k));
    });
  }
  if (brand) {
    // Use WC marca attribute as primary, fallback to name
    const b = brand.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    tires = tires.filter(p => {
      const pb = (p.brand||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
      const pn = (p.name||'').toLowerCase();
      return pb.includes(b) || pn.includes(b.toLowerCase());
    });
  }
  if (origin) {
    const o = origin.toUpperCase();
    tires = tires.filter(p => (p.name||'').toUpperCase().includes(o));
  }

  return tires.sort((a,b) => a.price - b.price);
}

function getRimSize(size) {
  // Extract rim diameter — last number in size string
  // Handles: 11R22.5, 215/60R16, 295/75/22.5, 295/75-22.5
  const m = (size||'').match(/(?:[Rr\/\-])(\d+\.?\d*)$/);
  return m ? parseFloat(m[1]) : 0;
}

function offersMounting(size) {
  // Only offer mounting for rim size 22.5 or larger (truck tires)
  return getRimSize(size) >= 22.5;
}

function getMountCost(size) {
  if (!offersMounting(size)) return 0;
  const prefix = (size||'').replace(/\D.*/,'').substring(0,3);
  return BIZ.largeSizePrefixes.includes(prefix) ? BIZ.mountLarge : BIZ.mountStandard;
}

function calcTotal(tire, qty, withMount, withValve=false, withDisposal=false) {
  // Override: no mounting service for rims smaller than 22.5
  if (!offersMounting(tire.size)) { withMount = false; withDisposal = false; }
  const tireT    = tire.price * qty;
  const mc       = withMount            ? getMountCost(tire.size) * qty : 0;
  const vc       = withValve            ? BIZ.valve * qty : 0;
  const disposal = withDisposal && withMount ? BIZ.disposal * qty : 0;
  const disc     = withMount            ? BIZ.mountDiscount * qty : 0;
  // Discount applies to tire price (not mount)
  // Tax applies to (tires - discount) + valves
  // Mount and disposal have no tax
  const tireTAfterDisc = tireT - disc;
  const taxBase        = tireTAfterDisc + vc;
  const tax            = taxBase * BIZ.taxRate;
  const grand          = tireTAfterDisc + vc + tax + mc + disposal;
  return { tireT, mc, vc, disposal, disc, tireTAfterDisc, tax, grand };
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
  // Válvula se cobra siempre
  lines.push(`   Válvulas ($5/c): ${fmt(c.vc)}`);
  if (withMount) {
    lines.push(`   Monte (${ml}): ${fmt(c.mc)}`);
    lines.push(`   Dto. por montar con nosotros: -${fmt(c.disc)}`);
  }
  lines.push(`   Tax FL (7%): ${fmt(c.tax)}`);
  lines.push(`   ━━━━━━━━━━━━━━`);
  lines.push(`   *TOTAL: ${fmt(c.grand)}*`);
  if (!withMount) lines.push(`🚚 Free delivery — área de Miami`);
  else lines.push(`📍 Instalación en tienda: 12301 NW 116th Ave, Suite 106, Medley FL`);
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
- Contacto: solo por WhatsApp chat (este mismo número)
- Email: ${BIZ.email}
- Horario: ${BIZ.hours}
- Free delivery en todo ${BIZ.freeDeliveryZone}

REGLAS DE PRECIOS:
- Tax FL: 7% sobre llantas y válvulas. El monte, descuento y disposición de basura NO llevan tax.
- Monte: ${BIZ.mountStandard}/llanta estándar | ${BIZ.mountLarge}/llanta medidas 385 y 425
- Válvula: ${BIZ.valve}/llanta — OPCIONAL. Pregunta solo el precio, sin explicar cuándo aplica.
- Disposición de llantas viejas: ${BIZ.disposal}/llanta — OPCIONAL, SOLO cuando el cliente monta con nosotros en tienda. Si pide delivery, NO mencionar esta opción.
- Descuento: -${BIZ.mountDiscount}/llanta al montar con nosotros — se descuenta del precio de la llanta, por lo que también reduce la base del tax
- Free delivery en el área de Miami. Otros condados tienen costo adicional.
- Pago en efectivo (cash): precio normal, sin descuento
- Pago con tarjeta de crédito: recargo del 3% sobre el total
- NO hay descuentos por pagar en efectivo

FINANCIACIÓN:
${FINANCE_OPTIONS.map(f => `- ${f.name}: ${f.note}`).join('\n')}

FLUJO DE CONVERSACIÓN — sigue este orden estricto:

PASO 1 — SALUDO Y NOMBRE (SIEMPRE PRIMERO):
- Si no ves [CUSTOMER NAME] en el contexto → el PRIMER mensaje que envíes SIEMPRE debe ser un saludo de bienvenida a Tires Depot y pedir el nombre. No preguntes por llantas hasta tener el nombre.

PASO 2 — TELÉFONO (solo si [NEEDS_PHONE]):
- Si ves [NEEDS_PHONE] en el contexto → pide el número de teléfono antes de continuar

PASO 3 — BÚSQUEDA DE LLANTAS:
- Si no tienes tamaño → pregúntalo
- Si tienes tamaño pero no posición → pregunta posición SOLO si es llanta de camión (rin 22.5 o mayor). Los valores exactos son: Steer (delantera), Traction (tracción/trasera), Trailer, All Position. Para llantas de automóvil (rin 16, 17, 18, etc.) NO preguntes la posición.
- Con tamaño + posición → muestra TODOS los resultados de [INVENTORY DATA] en lista numerada
- Si piden "la más económica" → destaca la #1 (lista ordenada precio asc)
- Si mencionan marca → filtra por esa marca
- Si mencionan origen (americanas, vietnamitas, brasileñas, japonesas, indias, camboyanas, etc.) → filtra por el país en el nombre del producto. El filtro de origen se mantiene mientras el cliente siga eligiendo dentro de esa misma búsqueda. Si hay varias opciones de la misma marca con diferente país, NUNCA las mezcles — muestra solo las que coinciden con el origen solicitado.
- Cliente elige llanta → pregunta cuántas → pregunta si monta con nosotros o prefiere delivery → si monta: pregunta si necesita válvulas ($5/c) y si quiere disposición de llantas viejas ($10/c) → muestra [QUOTE]. Si prefiere delivery: NO preguntes por disposición de llantas viejas (no aplica).

MANEJO DE PREGUNTAS FUERA DEL FLUJO (crítico):
- Si el cliente pregunta algo general (monte, válvula, delivery, financiación, ubicación) mientras ya hay una búsqueda activa → responde brevemente y LUEGO retoma: si ya mostraste opciones di "Retomando tu búsqueda, ¿cuál de estas opciones prefieres?" y repite la lista. NUNCA pidas de nuevo la medida o posición si ya las tienes.

PASO 4 — OFERTA DE EMAIL (solo si [OFFER_EMAIL]):
- Después de mostrar cotización o resultados, si ves [OFFER_EMAIL] → invita al cliente a registrar su email para recibir la *Llanta de la Semana* con precios especiales. Hazlo de forma breve y no invasiva. Si dice que no → acepta y continúa normalmente.

FORMATO LISTA:
N. *Marca* — $precio/llanta | stock unidades | Posición | Monte $X/llanta
Después pregunta cuántas llantas necesita y si va a montar con nosotros o prefiere delivery. Son opciones EXCLUYENTES: si monta con nosotros (trae el vehículo a la tienda) → descuento -$5/llanta, sin delivery. Si no monta → free delivery en el área de Miami, sin descuento.

ESTILO:
- Español por defecto. Inglés solo si el cliente escribe en inglés.
- ULTRA CORTO. Frases sueltas. Máximo 2 líneas. Sin cortesías, sin introducciones, sin despedidas.
- Si tienes [INVENTORY DATA] → muéstralo directo, sin preámbulo.
- Sin resultados → una línea corta y pregunta alternativa.
- Nunca inventes inventario — solo usa [INVENTORY DATA]
- Si el cliente dice cuántas llantas de cada posición necesita (ej: "2 steer y 8 traction") → muestra primero los resultados de una posición y luego di que buscarás la otra. No preguntes confirmaciones innecesarias.

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
  const sizeMatch = text.match(/(\d{2,3}[\/]\d{2,3}[\/rR]\d{2}[\w.]*|\d{2,3}[\/\\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*|\d{2}[rR]\d{2}\.?\d*)/i);
  if (sizeMatch) {
    // Normalize 235/85/16 → 235/85R16
    const newSize = sizeMatch[0].replace(/(\d{2,3}\/\d{2,3})\/(?!R)(\d{2})/i, '\$1R\$2');
    if (session.size && newSize !== session.size) {
      session.origin = null; // Reset origin only when changing to a different size
    }
    session.size = newSize;
    session.step = 'searching';
  }
  // If no name yet, also store size for later but keep step as name
  if (!session.name && text.match(/(\d{2,3}[\/\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*)/i)) {
    session.size = text.match(/(\d{2,3}[\/\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*)/i)[0];
  }

  const pos = normalizePosition(text);
  if (pos) session.position = pos;
  if (/all.?position|todas.?posicion/i.test(text)) session.position = 'trailer';

  const brands = ['Royal Black','Dynastone','Falken','Firestone','Pirelli','Continental','Yokohama',
    'Headway','Sunfull','Westlake','Aplus','Speedmax','Driveforce','DRC','JK','Kelly','Lanvigator',
    'Ovation','Itaro','Tornado','Easymax','Jetway','Kobe','Dplus'];
  const brandHit = brands.find(b => text.toLowerCase().includes(b.toLowerCase()));
  if (brandHit) session.brand = brandHit;

  const cheapest = /económic|econom|cheapest|más barat|barata|menor precio|precio.?más.?bajo/i.test(text);

  // Detect origin filter from customer text
  const ORIGIN_MAP = [
    { keywords: /american[ao]s?|\bUSA\b|estados unidos/i,  value: 'USA' },
    { keywords: /indian[ao]s?|\bINDIA\b/i,                 value: 'INDIA' },
    { keywords: /vietnamit[ao]s?|vietnam/i,                  value: 'VIETNAM' },
    { keywords: /camboyanas?|cambodia|camboya/i,              value: 'CAMBOIA' },
    { keywords: /brasileñ[ao]s?|brasil|brazil/i,             value: 'BRASIL' },
    { keywords: /japonesas?|japan|japon/i,                   value: 'JAPONESA' },
    { keywords: /chinas?|china/i,                            value: 'CHINA' },
    { keywords: /coreanas?|korea|corea/i,                    value: 'KOREA' },
  ];
  const originMatch = ORIGIN_MAP.find(o => o.keywords.test(text));
  if (originMatch) session.origin = originMatch.value;

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
      const tires = filterTires(session.size, session.position, session.brand, session.origin);
      session.tires = tires;

      if (tires.length > 0) {
        const cheapLabel = cheapest ? ' — CLIENTE QUIERE LA MÁS ECONÓMICA, destaca la #1' : '';
        const isTruck    = getRimSize(session.size) >= 22.5;
        const posLabel   = isTruck ? (session.position ? ` | Posición: ${session.position}` : ' | (sin filtro posición — ES CAMIÓN, pregunta posición)') : ' | AUTOMÓVIL';
        const mountNote  = isTruck ? '| Monte disponible' : '| NO PRESTAMOS SERVICIO DE MONTE PARA ESTA MEDIDA — no decir que es gratis, decir que no ofrecemos instalación';
        const list = tires.map((t,i) =>
          `${i+1}. *${t.brand}* — $${t.price}/llanta | ${t.stock} en stock${isTruck ? ` | Pos: ${t.position||'N/A'} | Monte: $${getMountCost(t.size)}/c` : ''}`
        ).join('\n');
        const brandLabel  = session.brand  ? ` | Marca: ${session.brand}` : '';
        const originLabel = session.origin ? ` | Origen: ${session.origin}` : '';
        inventoryContext = `\n\n[INVENTORY DATA: ${tires.length} llanta(s) para ${session.size}${posLabel}${brandLabel}${originLabel} ${mountNote}${cheapLabel}:\n${list}]`;

        // Reset position after use — each new position search is independent
        // Origin resets only when a new size is searched
        session.position = null;

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
        inventoryContext = `\n\n[INVENTORY DATA: Sin resultados para ${session.size}${session.position?' pos:'+session.position:''}${session.brand?' marca:'+session.brand:''}. Invita a continuar por este mismo chat.]`;
      }
    } catch (err) {
      console.error('Inventory fetch error:', err.message);
      inventoryContext = `\n\n[INVENTORY DATA: Error al obtener inventario. Invita a continuar por este mismo chat.]`;
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
    const mount    = !/sin monte|without mount|no mount|solo llant/i.test(text);
    const valve    = /válvula|valvula|valve|stem/i.test(text);
    const disposal = /basura|disposal|dispos|llantas viejas|old tires/i.test(text);
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

  // Log to Google Sheets (non-blocking)
  logConversation({
    platform,
    phone:      session.phone || userId,
    name:       session.name  || '',
    userMsg:    text,
    agentReply: reply,
  }).catch(() => {});

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
