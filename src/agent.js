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
  balancing: 35,       // optional — only for steer/front tires
  freeDeliveryZone: 'área de Miami',
  phone: '+1 (786) 518-5105',  // internal only — do not share in chat
  contactChannel: 'WhatsApp chat',
  address: '12301 NW 116th Ave, Suite 106, Medley FL 33178',  // warehouse/office
  serviceAddress: '9710 NW 114 Way Bay#1, Medley FL 33178',      // service center for mounting
  serviceLat: 25.876764,
  serviceLng: -80.355644,
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
  steer:          ['steer','direccion','dirección','delantera','adelante','front','steering','eje delantero','frontal','delantero'],
  traction:       ['traction','traccion','tracción','drive','motriz','trasera','rear','eje trasero'],
  trailer:        ['trailer','remolque','todas posiciones'],
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
const cache   = { data: null, ts: 0, ttl: 60 * 1000 }; // 1 min cache

async function fetchAllInventory() {
  if (cache.data && Date.now() - cache.ts < cache.ttl) return cache.data;
  const auth = Buffer.from(`${WC_KEY}:${WC_SEC}`).toString('base64');
  const all  = [];
  let page   = 1;
  while (true) {
    const res   = await fetch(`${WC_BASE}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish&_fields=id,name,price,regular_price,sale_price,stock_status,stock_quantity,in_stock,manage_stock,purchasable,tags,attributes,categories,meta_data`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`WC API error: ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  // Debug: log stock fields for Firestone products specifically
  const firestones = all.filter(p => p.name.toUpperCase().includes('FIRESTONE'));
  if (firestones.length > 0) {
    firestones.slice(0,3).forEach(p => {
      console.log(`[FIRESTONE RAW] "${p.name}" stock_status=${p.stock_status} stock_qty=${p.stock_quantity} meta_stock=${stockFromMeta(p)} price=${p.price} regular_price=${p.regular_price}`);
    });
  } else {
    console.log('[FIRESTONE RAW] No Firestone products returned from WC API!');
  }
  // Debug: log ALL attributes of first few products to verify structure
  if (all.length > 0) {
    all.slice(0, 3).forEach(p => {
      console.log('[WC ATTRS]', p.name);
      console.log('  attributes:', JSON.stringify(p.attributes?.map(a => ({
        name: a.name,
        slug: a.slug,
        options: a.options
      }))));
      console.log('  tags:', JSON.stringify(p.tags?.map(t => ({ name: t.name, slug: t.slug }))));
    });
  }

  const mapped = all.map(p => ({
    id:       p.id,
    name:     p.name,
    price:    parseFloat(p.price) || parseFloat(p.regular_price) || parseFloat(p.sale_price) || 0,
    stock:    (p.stock_quantity ?? 0) || stockFromMeta(p),
    inStock:  p.stock_status === 'instock' || p.in_stock === true || (p.stock_quantity != null && p.stock_quantity > 0) || stockFromMeta(p) > 0,
    tags:     p.tags || [],
    size:     attr(p,'tamano') || attr(p,'tamaño') || attr(p,'size') || sizeFromName(p.name),
    brand:    attr(p,'marca') || attr(p,'brand') || attr(p,'pa_brand') || brandFromTags(p) || brandFromName(p.name),
    position: attr(p,'position') || attr(p,'posicion') || attr(p,'posición') || posFromName(p.name),
    type:     p.categories?.some(c => c.slug.includes('camion') || c.slug.includes('truck')) ? 'truck' : 'passenger',
  }));
  // Debug: log products being filtered out
  mapped.filter(p => !p.inStock || p.price <= 0).slice(0,10).forEach(p =>
    console.log(`[FILTERED OUT] "${p.name}" inStock=${p.inStock} price=${p.price} qty=${p.stock} status=${p.stock_status}`)
  );
  cache.data = mapped.filter(p => (p.inStock || p.stock > 0) && p.price > 0);
  cache.ts = Date.now();

  // Debug: log brand resolution for first 5 products
  cache.data.slice(0, 5).forEach(p => {
    console.log(`[BRAND RESOLVED] "${p.name}" → brand="${p.brand}" size="${p.size}" pos="${p.position}"`);
  });

  return cache.data;
}

// ── Stock from bodega meta fields ───────────────────────────────────────────
// Stock is stored in custom meta fields _stock_bodega1, _stock_bodega2, _stock_bodega3
function stockFromMeta(p) {
  const meta = p.meta_data || [];
  let total = 0;
  for (const m of meta) {
    if (m.key && m.key.startsWith('_stock_')) {
      const qty = parseInt(m.value) || 0;
      total += qty;
    }
  }
  return total;
}

// ── attr(): find a WooCommerce product attribute by name/slug ───────────────
// Handles: pa_ prefix, accents, case differences, partial matches both ways
function attr(p, name) {
  const normalize = s => s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^pa_/, '')
    .trim();

  const target = normalize(name);

  const a = p.attributes?.find(x => {
    const attrName = normalize(x.name || '');
    const attrSlug = normalize(x.slug || '');
    return (
      attrName === target ||
      attrSlug === target ||
      attrName.includes(target) ||
      attrSlug.includes(target) ||
      target.includes(attrName) ||
      target.includes(attrSlug)
    );
  });

  // WooCommerce returns options array for custom attributes
  return a?.options?.[0] || null;
}

// Known brands list — used by brandFromTags and brandFromName
const KNOWN_BRANDS = [
  'Firestone','Yokohama','Headway','Kinbli','Invovic','Itaro','Dplus',
  'Dynastone','Kelly','Pirelli','Continental','Falken','DRC','Drc','Hubtrac','Lanvigator',
  'Ovation','Onix','Westlake','Aplus','Sunfull','Jetway','Kobe','JK',
  'Royal Black','Speedmax','Driveforce','Tornado','Easymax',
];

function brandFromTags(p) {
  const tag = p.tags?.find(t =>
    KNOWN_BRANDS.some(b => t.name.toLowerCase().includes(b.toLowerCase()))
  );
  return tag
    ? KNOWN_BRANDS.find(b => tag.name.toLowerCase().includes(b.toLowerCase()))
    : null;
}

function sizeFromName(n) {
  const m = n.match(/(\d{2,3}[-\/]\d{2,3}[-\/R]\d{2}[\w.]*|\d{2}R\d{2}\.?\d*)/i);
  return m
    ? m[0]
        .replace(/(\d{2,3})-(\d{2,3})-(\d{2})/i, '$1/$2R$3')
        .replace(/(\d{2,3}\/\d{2,3})\/(\d{2})/i, '$1R$2')
        .toUpperCase()
    : null;
}

function brandFromName(n) {
  return KNOWN_BRANDS.find(b => n.toLowerCase().includes(b.toLowerCase())) || '';
}

function posFromName(n) {
  const l = n.toLowerCase();
  if (l.includes('steer'))                            return 'Steer';
  if (l.includes('traction') || l.includes('drive'))  return 'Traction';
  if (l.includes('trailer'))                          return 'Trailer';
  if (l.includes('all position'))                     return 'All Position';
  return '';
}

function normalizeSize(s) {
  let v = (s||'').toUpperCase()
    .replace(/(\d{2,3})[\/\-](\d{2,3})[\/](\d{2})/g, '$1/$2R$3');
  return v.replace(/[^A-Z0-9]/g,'');
}

function filterTires(size, position, brand, origin) {
  let tires = cache.data || [];

  if (size) {
    const q = normalizeSize(size);
    tires = tires.filter(p => {
      const attrSize = normalizeSize(p.size);
      const nm       = normalizeSize(p.name);
      return attrSize === q || nm.includes(q);
    });
  }

  if (position) {
    const wcVal = (POSITION_WC_VALUE[position] || position).toLowerCase();
    tires = tires.filter(p => {
      const pp = (p.position||'').toLowerCase();
      return pp === wcVal;
    });
  }

  if (brand) {
    const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const b = normalize(brand);
    tires = tires.filter(p => {
      const pb = normalize(p.brand || '');
      const pn = normalize(p.name  || '');
      return pb.includes(b) || pn.includes(b);
    });
  }

  if (origin) {
    const o = origin.toUpperCase();
    tires = tires.filter(p => (p.name||'').toUpperCase().includes(o));
  }

  return tires.sort((a,b) => a.price - b.price);
}

function getRimSize(size) {
  const m = (size||'').match(/(?:[Rr\/\-])(\d+\.?\d*)$/);
  return m ? parseFloat(m[1]) : 0;
}

function offersMounting(size) {
  return getRimSize(size) >= 22.5;
}

function getMountCost(size) {
  if (!offersMounting(size)) return 0;
  const prefix = (size||'').replace(/\D.*/,'').substring(0,3);
  return BIZ.largeSizePrefixes.includes(prefix) ? BIZ.mountLarge : BIZ.mountStandard;
}

function calcTotal(tire, qty, withMount, withValve=false, withDisposal=false, withBalancing=false) {
  if (!offersMounting(tire.size)) { withMount = false; withDisposal = false; withBalancing = false; }
  const tireT     = tire.price * qty;
  const mc        = withMount                  ? getMountCost(tire.size) * qty : 0;
  const vc        = withValve                  ? BIZ.valve * qty : 0;
  const disposal  = withDisposal && withMount  ? BIZ.disposal * qty : 0;
  const balancing = withBalancing && withMount ? BIZ.balancing * qty : 0;
  const disc      = withMount                  ? BIZ.mountDiscount * qty : 0;
  const tireTAfterDisc = tireT - disc;
  const taxBase        = tireTAfterDisc + vc;
  const tax            = taxBase * BIZ.taxRate;
  const grand          = tireTAfterDisc + vc + tax + mc + disposal + balancing;
  return { tireT, mc, vc, disposal, balancing, disc, tireTAfterDisc, tax, grand };
}

function formatQuote(tire, qty, withMount, withValve=false, withDisposal=false, withBalancing=false) {
  const c   = calcTotal(tire, qty, withMount, withValve, withDisposal, withBalancing);
  const fmt = n => `$${n.toFixed(2)}`;
  const ml  = getMountCost(tire.size) === BIZ.mountLarge ? '$35/llanta (medida especial)' : '$25/llanta';
  const lines = [
    `🛞 *${qty}x ${tire.brand} ${tire.size}*`,
    `   ${tire.name}`,
    `   Llantas: ${fmt(c.tireT)}`,
  ];
  lines.push(`   Válvulas ($5/c): ${fmt(c.vc)}`);
  if (withMount) {
    lines.push(`   Monte (${ml}): ${fmt(c.mc)}`);
    lines.push(`   Dto. por montar con nosotros: -${fmt(c.disc)}`);
  }
  lines.push(`   Tax FL (7%): ${fmt(c.tax)}`);
  lines.push(`   ━━━━━━━━━━━━━━`);
  lines.push(`   *TOTAL: ${fmt(c.grand)}*`);
  if (!withMount) lines.push(`🚚 Free delivery — área de Miami`);
  else lines.push(`📍 Centro de servicios: 9710 NW 114 Way Bay#1, Medley FL 33178 | Sin cita previa`);
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

// ── Search session helpers ───────────────────────────────────────────────────
function getLastSearch(session) {
  if (!session.searches) return null;
  return [...session.searches].reverse().find(s => s.tires && s.tires.length > 0) || null;
}

function saveCurrentSearch(session) {
  if (!session.current || !session.current.size || !session.current.tires || session.current.tires.length === 0) return;
  if (!session.searches) session.searches = [];
  const key = [session.current.size, session.current.position, session.current.origin, session.current.brand]
    .filter(Boolean).join('|');
  const existing = session.searches.findIndex(s => s.key === key);
  const entry = { ...session.current, key };
  if (existing >= 0) session.searches[existing] = entry;
  else session.searches.push(entry);
}

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      history:       [],
      tires:         [],
      selectedTires: [],
      size:          null,
      position:      null,
      pendingPositions: [],
      shownPositions:   [],
      pendingQty:       {},
      brand:         null,
      name:          null,
      phone:         null,
      email:         null,
      step:          'greeting',
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
- Tax FL: 7% sobre llantas y válvulas. El monte, descuento y manejo de basura de llantas viejas NO llevan tax.
- Monte: ${BIZ.mountStandard}/llanta estándar | ${BIZ.mountLarge}/llanta medidas 385 y 425
- Válvula: ${BIZ.valve}/llanta — OPCIONAL. Pregunta solo el precio, sin explicar cuándo aplica.
- Manejo de basura de llantas viejas: ${BIZ.disposal}/llanta — OPCIONAL, solo cuando monta con nosotros.
- Balanceo: ${BIZ.balancing}/llanta — OPCIONAL, solo para llantas Steer (delanteras), solo cuando monta con nosotros.
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
- Si tienes tamaño pero no posición → pregunta posición SOLO si es llanta de camión (rin 22.5 o mayor). Las opciones son: Steer (delantera), Traction (tracción/drive), Trailer, All Position. Para autos NO preguntes posición.
- Cuando el cliente diga 'para atrás' o 'traseras' sin especificar más → pregunta si es Traction o Trailer (son posiciones diferentes).
- Si el cliente pide varias posiciones en un mensaje → muestra primero los resultados de la primera posición, luego busca la siguiente automáticamente.
- Con tamaño + posición → muestra TODOS los resultados de [INVENTORY DATA] en lista numerada
- Si piden "la más económica" → destaca la #1 (lista ordenada precio asc)
- Si mencionan marca → filtra por esa marca SOLO cuando está claramente asociada a esa posición. Ejemplo: 'Firestone delantera y 8 traseras' → Firestone SOLO para delantera, para traseras NO hay filtro de marca. Si el [INVENTORY DATA] no trae filtro de marca, muestra TODAS las marcas disponibles.
- Si mencionan origen (americanas, vietnamitas, brasileñas, japonesas, indias, camboyanas, etc.) → filtra por el país en el nombre del producto. El filtro de origen aplica SOLO a la búsqueda donde el cliente lo mencionó. Si [INVENTORY DATA] dice 'Sin filtro de origen' → muestra TODAS las marcas disponibles sin filtrar por país, aunque el cliente haya pedido americanas en una búsqueda anterior.
- Cuando el cliente elige llantas para VARIAS POSICIONES → la cotización final debe incluir TODOS los grupos. El tag [BÚSQUEDAS EN SESIÓN] muestra todas las búsquedas. Usa esos datos para presentar una cotización completa con cada grupo detallado y un total general.
- Hay 3 opciones EXCLUYENTES. Cuando el cliente haya seleccionado marca y cantidad → SIEMPRE pregunta ANTES de mostrar la cotización final: "¿Montas con nosotros (-$5/llanta), prefieres delivery gratis o pasas a recogerlas?"
  1. *Monta con nosotros* → descuento -$5/llanta, incluye monte en cotización, pregunta válvulas ($5/c) y manejo de llantas viejas ($10/c)
  2. *Free delivery* → sin monte, sin descuento de monte, free delivery área de Miami
  3. *Pickup* → sin monte, sin descuento, el cliente recoge en tienda
- NUNCA incluyas monte en la cotización si el cliente no confirmó explícitamente que va a montar.
- Si el cliente dice 'llevarme las gomas', 'paso a buscarlas', 'recoger', 'pickup', 'solo quiero las gomas' → es Pickup.
- SIEMPRE incluye todas las selecciones previas en la cotización final, no solo la última.

MANEJO DE PREGUNTAS FUERA DEL FLUJO (crítico):
- Si el cliente pregunta algo general (monte, válvula, delivery, financiación, ubicación) mientras ya hay una búsqueda activa → responde brevemente y LUEGO retoma: si ya mostraste opciones di "Retomando tu búsqueda, ¿cuál de estas opciones prefieres?" y repite la lista. NUNCA pidas de nuevo la medida o posición si ya las tienes.

PASO 4 — CONFIRMACIÓN Y DATOS DEL CLIENTE:
- Después de mostrar cotización final → pregunta: "¿Confirmamos el pedido?"
- Si el cliente confirma → solicita en UN SOLO mensaje los datos faltantes para la factura:
  1. Nombre completo (siempre pedirlo — el nombre de WhatsApp puede ser apodo o empresa, no es confiable)
  2. Empresa (si aplica)
  3. Dirección completa (siempre necesaria para la factura, independientemente de si es pickup, delivery o monte)
  4. Teléfono — ya lo tienes en [CUSTOMER PHONE], no lo pidas
  5. Correo electrónico
- Pide los 4 datos faltantes (nombre, empresa, dirección, email) en un solo mensaje.

PASO 5 — OFERTA DE EMAIL (solo si [OFFER_EMAIL]):
- Después de mostrar cotización o resultados, si ves [OFFER_EMAIL] → invita al cliente a registrar su email para recibir la *Llanta de la Semana* con precios especiales. Hazlo de forma breve y no invasiva. Si dice que no → acepta y continúa normalmente.

FORMATO LISTA:
N. *Marca* — $precio/llanta | stock unidades | Posición | Monte $X/llanta
Después pregunta cuántas llantas necesita y cómo prefiere recibirlas. Hay 3 opciones EXCLUYENTES:
1. Monta con nosotros → descuento -$5/llanta, pregunta válvulas y disposición de llantas viejas
2. Delivery gratis → área de Miami, sin descuento, sin preguntar disposición
3. Pickup → pasa a recoger al local, sin descuento, sin delivery

ESTILO:
- Español por defecto. Inglés solo si el cliente escribe en inglés.
- ULTRA CORTO. Frases sueltas. Máximo 2 líneas. Sin cortesías, sin introducciones, sin despedidas.
- Si tienes [INVENTORY DATA] → lista TODOS los productos numerados inmediatamente, sin preámbulo ni frases como 'tengo disponibles' o 'aquí están'. NUNCA digas 'voy a buscar' o 'espera que busco' si ya tienes [INVENTORY DATA] — la búsqueda YA se realizó. Muestra la lista directamente.
- Sin resultados para marca específica → di que no hay de esa marca y muestra inmediatamente las opciones disponibles de otras marcas para esa medida/posición. No esperes a que el cliente pregunte.
- Nunca inventes inventario — solo usa [INVENTORY DATA]
- Si el cliente dice cuántas llantas de cada posición necesita (ej: "2 steer y 8 traction") → muestra primero los resultados de una posición y luego di que buscarás la otra. No preguntes confirmaciones innecesarias.
- Cuando el cliente responda con un número después de ver una lista de opciones, interpreta ese número como la SELECCIÓN de esa opción (ej: responde "2" → elige la opción #2 de la lista), NO como cantidad. La cantidad ya se conoce del mensaje inicial.
- Si hay varias posiciones pendientes: muestra las opciones de una posición → espera que el cliente elija → confirma su elección → ENTONCES muestra las opciones de la siguiente posición. NO asumas ninguna selección que el cliente no haya hecho explícitamente.
- Si una posición tiene varias opciones (ej: 2 Firestone diferentes), el cliente DEBE elegir cuál antes de continuar. No tomes la primera por defecto.

IMPORTANTE: Los tags [INVENTORY DATA:], [QUOTE:], [CUSTOMER NAME:], etc. son instrucciones internas — NUNCA los copies literalmente en tu respuesta al cliente. Usa su contenido para formular tu respuesta.

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

  // Migrate old session structure if needed
  if (!session.current) {
    session.current = {
      size: session.size || null,
      position: session.position || null,
      origin: session.origin || null,
      brand: session.brand || null,
      tires: session.tires || [],
      qty: null,
      pendingPositions: session.pendingPositions || [],
      shownPositions: session.shownPositions || [],
      pendingQty: session.pendingQty || {},
    };
    session.searches = session.searches || [];
  }
  if (!session.current.pendingQty) session.current.pendingQty = {};
  if (!session.current.tires) session.current.tires = [];
  if (!session.selectedTires) session.selectedTires = {};
  if (!session.searches) session.searches = [];

  // WhatsApp: phone is the userId directly
  if (isWA && !session.phone) session.phone = userId;

  // Auto-reset if history is too old or client starts fresh
  const looksLikeNewInquiry = /\d{2,3}[\d\/R.]+|cuánto|precio|necesito|busco|tienen/i.test(text);
  if (looksLikeNewInquiry && session.history.length >= 6) {
    const savedName  = session.name;
    const savedPhone = session.phone;
    const savedEmail = session.email;
    sessions.set(userId, {
      history: [], tires: [], size: null, position: null,
      pendingPositions: [], shownPositions: [], pendingQty: {},
      origin: null, brand: null,
      name: savedName, phone: savedPhone, email: savedEmail,
      step: 'searching', logged: false, emailOffered: false,
    });
    return handleMessage(userId, text, platform);
  }

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
  }

  // ── Detect tire search params ─────────────────────────────────────────────
  const sizeMatch = text.match(/(\d{2,3}[\/]\d{2,3}[\/rR]\d{2}[\w.]*|\d{2,3}[\/\\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*|\d{2}[rR]\d{2}\.?\d*)/i);
  if (sizeMatch) {
    const newSize = sizeMatch[0].replace(/(\d{2,3}\/\d{2,3})\/(?!R)(\d{2})/i, '$1R$2');
    if (session.current.size && newSize !== session.current.size) {
      session.current.origin = null;
    }
    session.current.size = newSize;
    session.current.step = 'searching';
  }
  if (!session.name && text.match(/(\d{2,3}[\/\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*)/i)) {
    session.current.size = text.match(/(\d{2,3}[\/\]?\d{2,3}[zZrR]+\d{2}[\w.]*|11[rR]\d{2}\.?\d*)/i)[0];
  }

  // Detect qty per position
  const qtyPosMatches = [...text.matchAll(/(\d+)\s*(?:de\s+)?(?:llantas?\s+)?(?:de\s+)?(direccion|dirección|delantera|steer|traction|traccion|trasera|atrás|atras|trailer|remolque)/gi)];
  if (qtyPosMatches.length > 0) {
    qtyPosMatches.forEach(m => {
      const qty = parseInt(m[1]);
      const posText = m[2].toLowerCase();
      const posKey = Object.entries(POSITION_KEYWORDS).find(([k,kws]) => kws.some(kw => posText.includes(kw)))?.[0];
      if (posKey && qty) { if (!session.current.pendingQty) session.current.pendingQty = {}; session.current.pendingQty[posKey] = qty; }
    });
  }

  const pos = normalizePosition(text);
  if (pos) {
    session.current.position = pos;
    const allPositions = [];
    for (const [key, kws] of Object.entries(POSITION_KEYWORDS)) {
      if (kws.some(k => text.toLowerCase().includes(k))) allPositions.push(key);
    }
    if (allPositions.length > 1) {
      session.current.position = allPositions[0];
      session.current.pendingPositions = allPositions.slice(1);
    }
  }
  if (/all.?position|todas.?posicion/i.test(text)) session.current.position = 'trailer';

  const brandHit = KNOWN_BRANDS.find(b => text.toLowerCase().includes(b.toLowerCase()));
  if (brandHit) {
    const multiPosition = qtyPosMatches && qtyPosMatches.length > 1;
    session.current.brand = brandHit;
    session.current.brandOnlyForCurrent = multiPosition;
  }

  const cheapest = /económic|econom|cheapest|más barat|barata|menor precio|precio.?más.?bajo/i.test(text);

  // Detect origin filter
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
  if (originMatch) session.current.origin = originMatch.value;

  // ── Build context tags ────────────────────────────────────────────────────
  let contactContext = '';
  if (session.name)  contactContext += `\n[CUSTOMER NAME: ${session.name}]`;
  if (session.phone) contactContext += `\n[CUSTOMER PHONE: ${session.phone}]`;
  if (session.email) contactContext += `\n[CUSTOMER EMAIL: ${session.email}]`;

  let needsPhone = '';
  if (!isWA && session.name && !session.phone && session.step === 'phone') {
    needsPhone = '\n[NEEDS_PHONE]';
  }

  // ── Fetch inventory ───────────────────────────────────────────────────────
  let inventoryContext = '';
  const hasNewSearchTrigger = sizeMatch || pos || /all.?position|todas.?posicion/i.test(text) ||
    Object.keys(session.current.pendingQty||{}).some(k =>
      POSITION_KEYWORDS[k]?.some(kw => text.toLowerCase().includes(kw))
    );

  if (session.current.size && session.current.size.length > 3 && hasNewSearchTrigger) {
    try {
      await fetchAllInventory();
      if (!session.current.searchCount) session.current.searchCount = 0;
      const isFirstPosition = session.current.searchCount === 0;
      const brandForSearch = session.current.brandOnlyForCurrent && !isFirstPosition
        ? null
        : session.current.brand;
      session.current.searchCount++;

      console.log(`[FILTER] size=${session.current.size} pos=${session.current.position} origin=${session.current.origin} brand=${brandForSearch} (isFirst=${isFirstPosition})`);
      const tires = filterTires(session.current.size, session.current.position, brandForSearch, session.current.origin);
      session.current.tires = tires;

      if (tires.length > 0) {
        const cheapLabel = cheapest ? ' — CLIENTE QUIERE LA MÁS ECONÓMICA, destaca la #1' : '';
        const isTruck    = getRimSize(session.current.size) >= 22.5;
        const posLabel   = isTruck
          ? (session.current.position
              ? ` | Posición: ${session.current.position}`
              : ' | (sin filtro posición — ES CAMIÓN, pregunta posición)')
          : ' | AUTOMÓVIL';
        const mountNote = isTruck
          ? '| Monte disponible'
          : '| NO PRESTAMOS SERVICIO DE MONTE PARA ESTA MEDIDA — no decir que es gratis, decir que no ofrecemos instalación';
        const list = tires.map((t,i) =>
          `${i+1}. *${t.brand}* — $${t.price}/llanta | ${t.stock} en stock${isTruck ? ` | Pos: ${t.position||'N/A'} | Monte: $${getMountCost(t.size)}/c` : ''}`
        ).join('\n');
        const brandLabel  = session.current.brand  ? ` | Marca: ${session.current.brand}` : '';
        const originLabel = session.current.origin ? ` | Origen: ${session.current.origin}` : ' | Sin filtro de origen (mostrar todas las marcas disponibles)';
        inventoryContext = `\n\n[INVENTORY DATA: ${tires.length} llanta(s) para ${session.current.size}${posLabel}${brandLabel}${originLabel} ${mountNote}${cheapLabel}:\n${list}]`;

        if (session.current.position) session.current.shownPositions.push(session.current.position);

        // Process pending positions in same cycle
        while (session.current.pendingPositions && session.current.pendingPositions.length > 0) {
          const nextPos = session.current.pendingPositions.shift();
          session.current.position = nextPos;
          session.current.origin   = null;
          session.current.brand    = null;
          session.current.brandOnlyForCurrent = false;

          const nextTires = filterTires(session.current.size, nextPos, null, null);
          if (nextTires.length > 0) {
            const isTruckNext = getRimSize(session.current.size) >= 22.5;
            const nextList = nextTires.map((t,i) =>
              `${i+1}. *${t.brand}* — $${t.price}/llanta | ${t.stock} en stock${isTruckNext ? ` | Pos: ${t.position||'N/A'} | Monte: $${getMountCost(t.size)}/c` : ''}`
            ).join('\n');
            inventoryContext += `\n\n[INVENTORY DATA POSICIÓN ${nextPos.toUpperCase()}: ${nextTires.length} llanta(s):\n${nextList}]`;
            session.current.tires = nextTires;
          }
          if (session.current.position) session.current.shownPositions.push(session.current.position);
        }

        if (!session.current.pendingPositions || session.current.pendingPositions.length === 0) {
          session.current.position = null;
          session.current.origin   = null;
          session.current.brand    = null;
        }

        saveCurrentSearch(session);

        if (!session.logged && session.name) {
          logLead({
            platform,
            phone: session.phone || userId,
            name:  session.name,
            email: session.email || '',
            query: `${session.current.size} ${session.current.position||''} ${session.current.brand||''}`.trim(),
          });
          session.logged = true;
        }

      } else if (brandForSearch) {
        // No results with brand — retry without brand to show alternatives
        const isTruckRetry = getRimSize(session.current.size) >= 22.5;
        const tiresNoBrand = filterTires(session.current.size, session.current.position, null, session.current.origin);
        if (tiresNoBrand.length > 0) {
          session.current.tires = tiresNoBrand;
          const list = tiresNoBrand.map((t,i) =>
            `${i+1}. *${t.brand}* — $${t.price}/llanta | ${t.stock} en stock${isTruckRetry ? ` | Pos: ${t.position||'N/A'} | Monte: $${getMountCost(t.size)}/c` : ''}`
          ).join('\n');
          inventoryContext = `\n\n[INVENTORY DATA: BÚSQUEDA COMPLETADA — No hay ${brandForSearch} en ${session.current.size}${session.current.position?' pos:'+session.current.position:''}. Búsqueda ya realizada, NO digas que vas a buscar. Muestra AHORA estas alternativas (${tiresNoBrand.length}):\n${list}]`;
        } else {
          inventoryContext = `\n\n[INVENTORY DATA: Sin resultados para ${session.current.size}${session.current.position?' pos:'+session.current.position:''}. No hay stock de esa medida/posición.]`;
        }

        // Always mark this position as shown and process remaining pending positions
        if (session.current.position) session.current.shownPositions.push(session.current.position);

        while (session.current.pendingPositions && session.current.pendingPositions.length > 0) {
          const nextPos = session.current.pendingPositions.shift();
          session.current.position = nextPos;
          session.current.origin   = null;
          session.current.brand    = null;
          session.current.brandOnlyForCurrent = false;

          const nextTires = filterTires(session.current.size, nextPos, null, null);
          if (nextTires.length > 0) {
            const isTruckNext = getRimSize(session.current.size) >= 22.5;
            const nextList = nextTires.map((t,i) =>
              `${i+1}. *${t.brand}* — $${t.price}/llanta | ${t.stock} en stock${isTruckNext ? ` | Pos: ${t.position||'N/A'} | Monte: $${getMountCost(t.size)}/c` : ''}`
            ).join('\n');
            inventoryContext += `\n\n[INVENTORY DATA POSICIÓN ${nextPos.toUpperCase()}: ${nextTires.length} llanta(s):\n${nextList}]`;
            session.current.tires = nextTires;
          }
          if (session.current.position) session.current.shownPositions.push(session.current.position);
        }

        // Clear brand/origin after processing all positions
        session.current.position = null;
        session.current.origin   = null;
        session.current.brand    = null;
        session.current.brandOnlyForCurrent = false;

      } else {
        inventoryContext = `\n\n[INVENTORY DATA: Sin resultados para ${session.current.size}${session.current.position?' pos:'+session.current.position:''}. No hay stock de esa medida/posición.]`;
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

  const lastSearch = getLastSearch(session);
  const availableTires = session.current.tires.length > 0 ? session.current.tires : (lastSearch ? lastSearch.tires : []);

  const wantsFullQuote = /cotiz|total|cuanto|precio|quote|how much|desglose/i.test(text);
  if (wantsFullQuote && session.searches && session.searches.length > 1) {
    const combinedLines = ['*COTIZACION COMPLETA*'];
    let grandTotal = 0;
    const mount    = /\bmonte\b|\bmontar\b|\bmounting\b|monta con|instalaci/i.test(text) && !/sin monte|no monte|without mount|no mount/i.test(text);
    const valve    = /válvula|valvula|valve|stem/i.test(text);
    const disposal = /basura|disposal|dispos|llantas viejas/i.test(text);

    session.searches.forEach(s => {
      if (!s.tires || s.tires.length === 0) return;
      const tire = s.tires[0];
      const qty = (s.pendingQty && Object.values(s.pendingQty).reduce((a,b)=>a+b,0)) || 1;
      const c = calcTotal(tire, qty, mount, valve, disposal);
      combinedLines.push(`*${qty}x ${tire.brand} ${tire.size}${s.position?' '+s.position:''}* — $${c.grand.toFixed(2)}`);
      grandTotal += c.grand;
    });
    combinedLines.push(`\n*TOTAL GENERAL: $${grandTotal.toFixed(2)}*`);
    if (!mount) combinedLines.push('🚚 Free delivery — área de Miami');
    quoteContext = '\n\n[QUOTE:\n' + combinedLines.join('\n') + ']';

  } else if (availableTires.length > 0 && (qtyMatch || wantsQuote)) {
    let tire = availableTires[0];

    const isJustNumber = /^\s*\d+\s*$/.test(text);
    const pickMatch = text.match(/(?:número?|opción|el|la|#)\s*([1-9][0-9]?)(?:\s|$)/i) ||
                      (isJustNumber ? text.match(/(\d+)/) : null);

    if (pickMatch) {
      const idx = parseInt(pickMatch[1]) - 1;
      if (idx >= 0 && idx < availableTires.length) tire = availableTires[idx];
    }

    const brandPick = availableTires.findIndex(t =>
      t.brand && text.toLowerCase().includes(t.brand.toLowerCase())
    );
    if (brandPick >= 0) tire = session.current.tires[brandPick];

    if (isJustNumber || pickMatch || brandPick >= 0) {
      const posKey = session.current.shownPositions[session.current.shownPositions.length - 1] || 'default';
      session.selectedTires[posKey] = tire;
    }

    const totalQty = Object.values(session.current.pendingQty||{}).reduce((a,b)=>a+b,0) || (lastSearch?.qty || 0);
    const qty      = totalQty > 0 ? totalQty : (!isJustNumber && qtyMatch ? parseInt(qtyMatch[1]) : 4);
    const mount    = /\bmonte\b|\bmontar\b|\bmounting\b|monta con|instalaci/i.test(text) && !/sin monte|no monte|without mount|no mount/i.test(text);
    const valve    = /válvula|valvula|valve|stem/i.test(text);
    const disposal = /basura|disposal|dispos|llantas viejas|old tires/i.test(text);
    if (qty >= 1 && qty <= 24) {
      quoteContext = `\n\n[QUOTE:\n${formatQuote(tire, qty, mount)}]`;
    }
  }

  // ── Email offer ───────────────────────────────────────────────────────────
  let emailOffer = '';
  if (!session.emailOffered && !session.email && session.name && quoteContext) {
    emailOffer = '\n[OFFER_EMAIL]';
    session.emailOffered = true;
  }

  // ── Searches summary ──────────────────────────────────────────────────────
  let searchesSummary = '';
  if (session.searches && session.searches.length > 0) {
    const summary = session.searches.map(s =>
      `${s.size}${s.position?' '+s.position:''}: ${(s.tires||[]).slice(0,3).map(t=>`${t.brand} $${t.price}`).join(', ')}`
    ).join(' | ');
    searchesSummary = `\n[BÚSQUEDAS EN SESIÓN: ${summary}]`;
  }

  // ── Send to Claude ────────────────────────────────────────────────────────
  const userMessage = text + contactContext + needsPhone + searchesSummary + inventoryContext + quoteContext + emailOffer;

  session.history.push({ role:'user', content: userMessage });
  if (session.history.length > 6) session.history = session.history.slice(-6);

  if (session.history.length === 1 && !session.name) session.step = 'name';

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system:     SYSTEM_PROMPT,
    messages:   session.history,
  });

  const reply = response.content[0].text;
  session.history.push({ role:'assistant', content: reply });

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
