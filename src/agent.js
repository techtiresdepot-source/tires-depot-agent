'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const { google } = require('googleapis');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const BOT_VERSION = '2026-07-08-ai-pending-decline-v35';
console.log(`[BOT VERSION] ${BOT_VERSION}`);

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
  weeklyDeliveryZone: 'West Palm Beach los jueves',
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
  { name: 'Snap Finance',           note: 'Aprobación en minutos, sin crédito requerido', noteEn: 'Approval in minutes, no credit required' },
  { name: 'Acima',                  note: 'Lease-to-own, sin score mínimo', noteEn: 'Lease-to-own, no minimum score' },
  { name: 'American First Finance', note: 'Financiación flexible, sin depósito', noteEn: 'Flexible financing, no deposit' },
  { name: 'Koalafi',                note: 'Aprobación rápida, sin crédito perfecto', noteEn: 'Fast approval, perfect credit not required' },
];

const POSITION_KEYWORDS = {
  steer:          ['steer','direccion','dirección','delantera','adelante','front','steering','eje delantero','frontal','delantero','del frente','frente'],
  traction:       ['traction','traccion','tracción','drive','motriz','trasera','rear','eje trasero'],
  trailer:        ['trailer','remolque'],
  'all position': ['all position','all-position','todas posiciones','toda posición','multi','universal'],
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
const SHEET_LEADS_TAB  = 'Pedidos';

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

// Google Sheets — only confirmed orders are logged (Pedidos tab)

async function ensureLeadsSheetHeaders() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_LEADS_TAB}!A1:J1`,
    });
    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_LEADS_TAB}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['fecha','nombre','empresa','direccion','telefono','email','pedido','total','modalidad','promo']] },
      });
    }
  } catch (e) {
    console.error('Leads sheet header error:', e.message);
  }
}
ensureLeadsSheetHeaders().catch(() => {});

async function logOrderToSheet({ name, company, address, phone, email, order, total, modalidad, promo }) {
  try {
    const sheets = await getSheetsClient();
    const row = [
      new Date().toISOString(),
      name      || '',
      company   || '',
      address   || '',
      phone     || '',
      email     || '',
      (order    || '').substring(0, 300),
      total     || '',
      modalidad || '',
      promo     || 'no',
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_LEADS_TAB}!A:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log(`[SHEET ORDER] ${name} | ${email} | ${total}`);
    return true;
  } catch (e) {
    console.error('Order sheet log error:', e.message);
    return false;
  }
}


// ── WooCommerce inventory ───────────────────────────────────────────────────
const WC_BASE = process.env.WC_STORE_URL || 'https://tires-depot.com';
const WC_KEY  = process.env.WC_CONSUMER_KEY;
const WC_SEC  = process.env.WC_CONSUMER_SECRET;
const cache   = { data: null, ts: 0, ttl: 2 * 60 * 1000 }; // 2 min cache

async function fetchAllInventory(forceRefresh=false) {
  if (!forceRefresh && cache.data && Date.now() - cache.ts < cache.ttl) return cache.data;
  const auth = Buffer.from(`${WC_KEY}:${WC_SEC}`).toString('base64');
  const all  = [];
  let page   = 1;
  while (true) {
    const res   = await fetch(`${WC_BASE}/wp-json/wc/v3/products?per_page=100&page=${page}&status=publish&_fields=id,name,price,regular_price,sale_price,on_sale,date_on_sale_from,date_on_sale_to,stock_status,stock_quantity,in_stock,manage_stock,purchasable,tags,attributes,categories`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`WC API error: ${res.status}`);
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  // Debug: log ALL 11R22.5 products with their raw price fields
  const firestones = all.filter(p => p.name.toUpperCase().includes('FIRESTONE') || p.name.toUpperCase().includes('11R22'));
  firestones.forEach(p => {
    console.log(`[11R22/FIRESTONE RAW] "${p.name}" price="${p.price}" reg="${p.regular_price}" sale="${p.sale_price}" status=${p.stock_status} qty=${p.stock_quantity}`);
  });
  if (firestones.length === 0) console.log('[11R22/FIRESTONE RAW] NONE RETURNED FROM API');
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
    regularPrice: parseFloat(p.regular_price) || 0,
    salePrice:    parseFloat(p.sale_price) || 0,
    onSale:       p.on_sale === true,
    saleFrom:     p.date_on_sale_from || null,
    saleTo:       p.date_on_sale_to || null,
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
  cache.data = mapped.filter(p => p.inStock && p.price > 0);
  console.log(`[CACHE] ${cache.data.length} products in cache (from ${all.length} total)`);
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

function normalizeRim(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 3) return `${digits.slice(0, 2)}.${digits[2]}`;
  if (digits.length === 2) return digits;
  return null;
}

function buildMetricSize(width, profile, rimRaw) {
  const rim = normalizeRim(rimRaw);
  if (!rim) return null;
  return `${width}/${profile}R${rim}`.toUpperCase();
}

function buildCommercialSize(width, rimRaw) {
  const rim = normalizeRim(rimRaw);
  if (!rim) return null;
  return `${width}R${rim}`.toUpperCase();
}

function extractTireSize(text) {
  const t = String(text || '');

  const commercialWithR = t.match(/\b(1[0-3])\s*R\s*[.]?\s*(2[0-9](?:\s*[.]?\s*[05])?)\b/i);
  if (commercialWithR) {
    const built = buildCommercialSize(commercialWithR[1], commercialWithR[2]);
    if (built) return built;
  }

  const commercialWithSeparator = t.match(/\b(1[0-3])\s*[-\/.]\s*(2[0-9](?:\s*[.]?\s*[05])?)\b/i);
  if (commercialWithSeparator) {
    const built = buildCommercialSize(commercialWithSeparator[1], commercialWithSeparator[2]);
    if (built) return built;
  }

  const compactCommercial = t.match(/\b(1[0-3])\s*[-\/]?\s*(?:R\s*)?(2[0-9])\s*[.]?\s*([05])\b/i);
  if (compactCommercial) return `${compactCommercial[1]}R${compactCommercial[2]}.${compactCommercial[3]}`.toUpperCase();

  const separatedMetric = t.match(/\b(\d{3})\s*[\/\-.\s]\s*(\d{2})\s*(?:[\/\-.\s]*R\s*[.]?\s*|[\/\-.\s]+)(\d{2}(?:\s*[.]?\s*[05])?)\b/i);
  if (separatedMetric) {
    const built = buildMetricSize(separatedMetric[1], separatedMetric[2], separatedMetric[3]);
    if (built) return built;
  }

  const compactMetricWithR = t.match(/\b(\d{3})(\d{2})\s*R\s*[.]?\s*(\d{2,3})\b/i);
  if (compactMetricWithR) {
    const built = buildMetricSize(compactMetricWithR[1], compactMetricWithR[2], compactMetricWithR[3]);
    if (built) return built;
  }

  const compactMetricPrefix = t.match(/\b(\d{3})(\d{2})\s+(?:(?:R\s*[.]?\s*)?)(\d{2,3})\b/i);
  if (compactMetricPrefix) {
    const built = buildMetricSize(compactMetricPrefix[1], compactMetricPrefix[2], compactMetricPrefix[3]);
    if (built) return built;
  }

  const compactMetric = t.match(/\b(\d{3})(\d{2})(\d{2,3})\b/);
  if (compactMetric) {
    const built = buildMetricSize(compactMetric[1], compactMetric[2], compactMetric[3]);
    if (built) return built;
  }

  const explicit = t.match(/\b(\d{2,3}\s*\/\s*\d{2,3}\s*R\s*\d{2}(?:\.\d)?|\d{2,3}\s*\/\s*\d{2,3}\s*\/\s*R\s*\d{2}(?:\.\d)?|\d{2,3}\s*\/\s*\d{2,3}\s*\/\s*\d{2}(?:\.\d)?|11\s*R\s*\d{2}(?:\.\d)?|\d{2}\s*R\s*\d{2}(?:\.\d)?)\b/i);
  if (!explicit) return null;
  return explicit[1]
    .replace(/\s+/g, '')
    .replace(/\s*\/\s*/g, '/')
    .replace(/(\d{2,3}\/\d{2,3})\/R/i, '$1R')
    .replace(/(\d{2,3}\/\d{2,3})\/(\d{2}(?:\.\d)?)/i, '$1R$2')
    .toUpperCase();
}

function isRimOnlySize(text) {
  const t = String(text || '').trim();
  if (extractTireSize(t)) return false;
  return /\b(?:rin|rim|r)?\s*(?:22\s*[.]?\s*5|24\s*[.]?\s*5|22|24)\b/i.test(t)
    && !/\b\d{3}\s*[\/\-\s]?\s*\d{2}\b/i.test(t)
    && !/\b1[0-3]\s*R?\s*2[0-9]/i.test(t);
}

function askPreciseSizeForRimReply(text='', session=null) {
  if (isEnglishMessage(text, session)) {
    return 'Is it regular 11R22.5 or low profile, like 295/75R22.5 or 275/80R22.5?';
  }
  return '¿Es regular 11R22.5 o low profile, como 295/75R22.5 o 275/80R22.5?';
}

function noStockReply(size, text='', session=null) {
  if (isEnglishMessage(text, session)) return `Sorry, we don't have tires in size ${size} in stock right now.`;
  return `Lo siento, no tenemos llantas de la medida ${size} en stock en este momento.`;
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
    const beforeBrand = tires.length;
    tires = tires.filter(p => {
      const pb = normalize(p.brand || '');
      const pn = normalize(p.name  || '');
      return pb.includes(b) || pn.includes(b);
    });
    console.log(`[BRAND FILTER] brand=${brand} before=${beforeBrand} after=${tires.length} sample=${tires.slice(0,2).map(t=>t.brand+' '+t.size).join(', ')}`);
    if (tires.length === 0) {
      // Log what brands were available before brand filter
      const normalize2 = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const allBrandsInSize = [...new Set((cache.data||[]).filter(p => {
        if (!size) return true;
        const q = normalizeSize(size);
        return normalizeSize(p.size) === q || normalizeSize(p.name).includes(q);
      }).map(p => p.brand))];
      console.log(`[BRAND FILTER MISS] available brands for ${size}: ${allBrandsInSize.join(', ')}`);
    }
  }

  if (origin) {
    const o = origin.toUpperCase();
    tires = tires.filter(p => (p.name||'').toUpperCase().includes(o));
  }

  return tires.sort((a,b) => a.price - b.price);
}

function formatInventoryOption(tire, index, isTruck) {
  const label = tire.name || `${tire.brand || 'Llanta'} ${tire.size || ''}`.trim();
  return `${index+1}. *${label}* — $${tire.price}/llanta | ${tire.stock} en stock${isTruck ? ` | Pos: ${tire.position||'N/A'}` : ''}`;
}

function inventorySelectionQuestion(text='', session=null) {
  return isEnglishMessage(text, session) ? 'Which one do you prefer?' : '¿Cuál prefieres?';
}

function inventoryQuantityQuestion(text='', session=null) {
  return isEnglishMessage(text, session) ? 'How many tires do you need?' : '¿Cuántas llantas necesitas?';
}

function inventoryFollowupQuestion(optionCount, text='', session=null) {
  return optionCount === 1 ? inventoryQuantityQuestion(text, session) : inventorySelectionQuestion(text, session);
}

function buildExactInventoryReplyFromSearches(session, text='') {
  const searches = (session.searches || []).filter(s => s && Array.isArray(s.tires) && s.tires.length > 0);
  if (searches.length === 0) return '';
  const blocks = searches.map(s => {
    const isTruck = getRimSize(s.size) >= 22.5;
    return s.tires.map((t, i) => formatInventoryOption(t, i, isTruck)).join('\n');
  });
  const optionCount = searches.reduce((sum, s) => sum + (s.tires || []).length, 0);
  return `${blocks.join('\n\n')}\n\n${inventoryFollowupQuestion(optionCount, text, session)}`;
}

function asksToRepeatInventoryOptions(text='') {
  return /opciones|lista|repite|cu[aá]les eran|cu[aá]l prefieres|available|options|which one|show.*again|send.*again/i.test(text);
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
const DEFAULT_POSITION_KEY = 'default';

function validRequestedQty(qty) {
  const n = Number.parseInt(qty, 10);
  return Number.isInteger(n) && n >= 1 && n <= 24 ? n : null;
}

function ensureQuantityState(session) {
  if (!session.requestedQtyByPosition) session.requestedQtyByPosition = {};

  // One-time migration from previous duplicated state. After this point the
  // only writable quantity source is session.requestedQtyByPosition.
  const legacyQty = session.pendingQty || session.current?.pendingQty || {};
  Object.entries(legacyQty).forEach(([posKey, qty]) => {
    const validQty = validRequestedQty(qty);
    if (validQty && !session.requestedQtyByPosition[posKey]) {
      session.requestedQtyByPosition[posKey] = validQty;
    }
  });

  (session.searches || []).forEach(search => {
    const posKey = search.position || DEFAULT_POSITION_KEY;
    const validQty = validRequestedQty(search.positionQty || search.qty);
    if (validQty && !session.requestedQtyByPosition[posKey]) {
      session.requestedQtyByPosition[posKey] = validQty;
    }
    delete search.pendingQty;
    delete search.positionQty;
    delete search.qty;
  });

  if (session.current) {
    delete session.current.pendingQty;
    delete session.current.qty;
  }
  delete session.pendingQty;
}

function setRequestedQty(session, posKey, qty, searchKey=null) {
  const validQty = validRequestedQty(qty);
  if (!validQty) return false;
  ensureQuantityState(session);
  session.requestedQtyByPosition[posKey || DEFAULT_POSITION_KEY] = validQty;
  if (searchKey) {
    session.requestedQtyBySearch = session.requestedQtyBySearch || {};
    session.requestedQtyBySearch[searchKey] = validQty;
  }
  return true;
}

function getRequestedQty(session, posKey, searchKey=null) {
  ensureQuantityState(session);
  return (searchKey && session.requestedQtyBySearch?.[searchKey])
    || session.requestedQtyByPosition[posKey]
    || session.requestedQtyByPosition[DEFAULT_POSITION_KEY]
    || 1;
}

function extractPositionQuantities(text) {
  const matches = [...text.matchAll(/(\d+)\s*(?:[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{0,25}?)(?:de\s+|para\s+)?(direccion|dirección|delantera|adelante|delantero|frontal|steer|traction|traccion|tracción|trasera|atrás|atras|trailer|remolque)/gi)];
  return matches
    .map(m => {
      const qty = validRequestedQty(m[1]);
      const posText = m[2].toLowerCase();
      const posKey = Object.entries(POSITION_KEYWORDS)
        .find(([, kws]) => kws.some(kw => posText.includes(kw)))?.[0];
      return qty && posKey ? { qty, posKey } : null;
    })
    .filter(Boolean);
}

function extractGeneralQuantity(text) {
  const m = text.match(/\b([1-9][0-9]?)\s*(llantas?|tires?|ruedas?|unidades?|pcs?|gomas?)\b/i);
  return m ? validRequestedQty(m[1]) : null;
}

function extractBareQuantity(text) {
  const m = text.match(/^\s*([1-9][0-9]?)\s*$/);
  return m ? validRequestedQty(m[1]) : null;
}

function normalizeProductText(value='') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bjet\s+way\b/g, 'jetway')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findSelection(text, tires) {
  if (!tires || tires.length === 0) return null;
  const isJustNumber = /^\s*\d+\s*$/.test(text);
  const pickMatch = text.match(/(?:número?|opción|el|la|#)\s*([1-9][0-9]?)(?:\s|$)/i)
    || (isJustNumber ? text.match(/(\d+)/) : null);
  if (pickMatch) {
    const idx = Number.parseInt(pickMatch[1], 10) - 1;
    if (idx >= 0 && idx < tires.length) return { tire: tires[idx], idx, kind: 'index' };
  }
  const normalizedInput = normalizeProductText(text);
  const genericTokens = new Set(['steer','traction','trailer','position','all','tire','tires','llanta','llantas','quiero','necesito']);
  const brandIdx = tires.findIndex(t => {
    const brand = normalizeProductText(t.brand);
    const name = normalizeProductText(t.name);
    return (brand && normalizedInput.includes(brand))
      || name.split(' ').some(token =>
        token.length >= 4
        && !genericTokens.has(token)
        && !/^\d+$/.test(token)
        && normalizedInput.split(' ').includes(token)
      );
  });
  return brandIdx >= 0 ? { tire: tires[brandIdx], idx: brandIdx, kind: 'brand' } : null;
}

function getSelectionPositionKey(session) {
  const shownPos = session.current?.shownPositions?.length > 0
    ? session.current.shownPositions
    : (session.lastShownPositions || []);
  return shownPos[shownPos.length - 1] || DEFAULT_POSITION_KEY;
}

function getNextUnselectedSearch(session) {
  const seenPositions = new Set();
  for (const search of session.searches || []) {
    if (!search?.tires?.length) continue;
    if (!search.position && (session.searches || []).some(other =>
      other !== search && other.position && other.size === search.size
    )) continue;
    const posKey = search.position || DEFAULT_POSITION_KEY;
    if (seenPositions.has(posKey)) continue;
    seenPositions.add(posKey);
    if (session.declinedPositions?.[posKey]) continue;
    if (!session.selectedTiresBySearch?.[search.key]) return search;
  }
  return null;
}

function extractDeclinedPositions(text) {
  const declinePattern = /m[aá]s barat[oa]s?.*(?:otro lado|otra parte)|consegu[ií].*(?:otro lado|otra parte)|no (?:quiero|necesito|llevo|me llevo|voy a llevar|comprar[eé])|ya no|descart[oa]|skip|don't want|do not want|got .* cheaper elsewhere/i;
  return String(text || '')
    .split(/,|;|\bpero\b|\bas[ií] que\b|\bentonces\b|\bbut\b|\bso\b/i)
    .filter(clause => declinePattern.test(clause))
    .flatMap(clause => Object.entries(POSITION_KEYWORDS)
      .filter(([, keywords]) => keywords.some(keyword => clause.toLowerCase().includes(keyword)))
      .map(([position]) => position));
}

function pendingPositionSelectionReply(search, text='', session=null) {
  const options = search.tires.map((tire, index) => formatInventoryOption(tire, index)).join('\n');
  const labelsEs = {
    steer: 'direccional/steer',
    traction: 'tracción/traction',
    trailer: 'trailer/remolque',
    'all position': 'all position/toda posición',
  };
  const label = isEnglishMessage(text, session)
    ? (POSITION_WC_VALUE[search.position] || search.position || 'this position')
    : (labelsEs[search.position] || search.position || 'esta posición');
  const question = isEnglishMessage(text, session)
    ? `Which one do you prefer for ${label}?`
    : `¿Cuál prefieres para ${label}?`;
  return `${options}\n\n${question}`;
}

function wantsFinancing(text) {
  return /financiaci[oó]n|financiamiento|financiar|finance|financing|application|aplicaci[oó]n|aplicar|credito|cr[eé]dito|cuota inicial|inicial|dep[oó]sito|deposit|down payment|how much down/i.test(text);
}

function wantsFinancingHandoff(text, session) {
  if (session.awaitingFinanceNeedAnswer && /\b(si|sí|yes|claro|dale|ok|necesito|quiero|aplicar|aplicaci[oó]n|application)\b/i.test(text)) {
    return true;
  }
  return /(?:necesito|quiero|me interesa|voy a|para)\s+(?:financiaci[oó]n|financiar|finance|financing)|aplicar|aplicaci[oó]n|application|solicitud|tramitar/i.test(text);
}

function isEnglishMessage(text, session=null) {
  if (session && session.language) return session.language === 'en';
  const spanishSignals = /\b(hola|buen[oa]s?|quiero|quer[ií]a|tienes?|tienen|ofrecen|ofreces|necesito|busco|precio|precios|cu[aá]nto|cuanto|medida|llanta|llantas|goma|gomas|financiaci[oó]n|financiamiento|cr[eé]dito|aplicaci[oó]n|cuota|inicial|dep[oó]sito|asesor|mayor|mayoreo|recoger|env[ií]o|entrega|gracias|si|sí)\b/i;
  if (spanishSignals.test(text)) return false;
  // Position words like "steer", "traction", "trailer", "front", "rear" and "drive"
  // are common technical terms in Spanish chats; they should not flip the language.
  return /\b(how much|how much down|down payment|i need|i'm looking|im looking|looking for|can i|get more info|do you have|price for|quote for|tire price|tires price|need tires?|need financing|send application|thank you)\b/i.test(text);
}

function initialLanguageFromText(text='') {
  return isEnglishMessage(text) ? 'en' : 'es';
}

function financingInfoReply(text='', session=null) {
  if (isEnglishMessage(text, session)) {
    const lines = FINANCE_OPTIONS.map(f => `• *${f.name}*: ${f.noteEn}`).join('\n');
    return `We have these 4 financing options:\n\n${lines}\n\nDo you need financing?`;
  }
  const lines = FINANCE_OPTIONS.map(f => `• *${f.name}*: ${f.note}`).join('\n');
  return `Tenemos estas 4 opciones de financiación:\n\n${lines}\n\n¿Necesitas financiación?`;
}

function financingAdvisorReply(text='', session=null) {
  if (isEnglishMessage(text, session)) return 'An advisor will assist you as soon as possible.';
  return 'Te atenderemos a la mayor brevedad posible.';
}

function wantsWholesale(text) {
  return /mayorista|mayoreo|al por mayor|por mayor|wholesale|distribuidor|distribuci[oó]n|bulk|volumen|flota|fleet/i.test(text);
}

function advisorHandoffReply(text='', session=null) {
  if (isEnglishMessage(text, session)) return 'An advisor will assist you as soon as possible.';
  return 'Te atenderemos a la mayor brevedad posible.';
}

function completedOrderReply(modalidad, text='', session=null) {
  const english = isEnglishMessage(text, session);
  if (modalidad === 'monte') {
    return english
      ? 'Thank you. Your order has been recorded. You can bring your vehicle to *9710 NW 114 Way Bay#1, Medley FL 33178*, Mon-Fri 9am-5pm or Sat 9am-1pm. No appointment needed.'
      : 'Gracias. Tu pedido quedó registrado. Puedes traer tu vehículo a *9710 NW 114 Way Bay#1, Medley FL 33178*, Lun-Vie 9am-5pm o Sáb 9am-1pm. Sin cita previa.';
  }
  if (modalidad === 'delivery') {
    return english
      ? 'Thank you. Your order has been recorded. We will notify you when it is out for delivery.'
      : 'Gracias. Tu pedido quedó registrado. Te avisaremos cuando salga para entrega.';
  }
  return english
    ? 'Thank you. Your order has been recorded. You can pick it up at *12301 NW 116th Ave, Suite 106, Medley FL 33178*, Mon-Fri 9am-5pm or Sat 9am-1pm.'
    : 'Gracias. Tu pedido quedó registrado. Puedes recogerlo en *12301 NW 116th Ave, Suite 106, Medley FL 33178*, Lun-Vie 9am-5pm o Sáb 9am-1pm.';
}

function cartSummary(session, text='') {
  const english = isEnglishMessage(text, session);
  const lines = (session.cartLines || []).filter(line => line.tire && line.qty);
  if (!lines.length) return english ? 'Your cart is empty.' : 'Tu carrito está vacío.';
  const title = english ? '*YOUR ORDER*' : '*TU PEDIDO*';
  return [
    title,
    ...lines.map((line, index) => {
      const position = line.position ? ` | ${line.position}` : '';
      const unit = english ? 'tire' : 'llanta';
      return `${index + 1}. ${line.qty}x ${line.tire.name || `${line.tire.brand} ${line.size}`}${position} | $${line.tire.price}/${unit}`;
    }),
  ].join('\n');
}

function removeCartLine(session, text='') {
  const lines = (session.cartLines || []).filter(line => line.tire && line.qty);
  const indexMatch = text.match(/(?:quita|quitar|elimina|eliminar|saca|sacar|remove|delete)\s+(?:la\s+|el\s+|opci[oó]n\s+|#)?([1-9][0-9]?)/i);
  let target = indexMatch ? lines[Number(indexMatch[1]) - 1] : null;
  if (!target) {
    const lower = text.toLowerCase();
    target = lines.find(line =>
      (line.tire.brand && lower.includes(line.tire.brand.toLowerCase()))
      || (line.tire.name && lower.includes(line.tire.name.toLowerCase()))
    );
  }
  if (!target) return false;
  session.cartLines = session.cartLines.filter(line => line.key !== target.key);
  return true;
}

function cartActionQuestion(text='', session=null) {
  return isEnglishMessage(text, session)
    ? 'Would you like to add anything else, or should I show you your order?'
    : '¿Quieres agregar algo más o te muestro tu pedido?';
}

function cartReviewQuestion(text='', session=null) {
  return isEnglishMessage(text, session)
    ? 'Is everything correct, or would you like to add or remove something?'
    : '¿Está todo correcto o quieres agregar o quitar algo?';
}

async function classifyPendingPositionReply(text, position, language='es') {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 40,
      system: 'Classify a customer reply about a pending tire position. Return only JSON: {"action":"decline"} when they clearly reject all options for that position, otherwise {"action":"unclear"}. Do not infer additions, selections, quantities, or other actions.',
      messages: [{
        role: 'user',
        content: `Language: ${language}\nPending position: ${position || 'unknown'}\nCustomer reply: ${text}`,
      }],
    });
    const parsed = JSON.parse(response.content?.[0]?.text || '{}');
    return parsed.action === 'decline' ? 'decline' : 'unclear';
  } catch (err) {
    console.error('Pending position classification error:', err.message);
    return 'unclear';
  }
}

function isActiveWooSale(tire, now=Date.now()) {
  if (!tire?.onSale || !tire.salePrice) return false;
  const from = tire.saleFrom ? Date.parse(tire.saleFrom) : null;
  const to = tire.saleTo ? Date.parse(tire.saleTo) : null;
  return (!from || Number.isNaN(from) || now >= from)
    && (!to || Number.isNaN(to) || now <= to);
}

function asksAboutTirePromotion(text='') {
  return /promoci[oó]n|oferta|especial de la semana|llanta de la semana|tire of the week|on sale|en sale|sale price|special price/i.test(text);
}

function promotionReply(inventory, text='', session=null) {
  const english = isEnglishMessage(text, session);
  const size = extractTireSize(text);
  const normalizedInput = normalizeProductText(text);
  const brand = KNOWN_BRANDS.find(item => normalizedInput.includes(normalizeProductText(item)));
  let candidates = inventory.filter(tire =>
    (!size || normalizeSize(tire.size) === normalizeSize(size))
    && (!brand || normalizeProductText(tire.brand) === normalizeProductText(brand) || normalizeProductText(tire.name).includes(normalizeProductText(brand)))
  );

  if (!size && !brand) {
    const contextualTire = [...(session?.cartLines || [])].reverse().find(line => line.tire)?.tire
      || (session?.lastShownSearchKey && session?.selectedTiresBySearch?.[session.lastShownSearchKey]);
    candidates = contextualTire
      ? inventory.filter(tire => tire.id === contextualTire.id)
      : inventory.filter(tire => isActiveWooSale(tire));
  }

  const active = candidates.filter(tire => isActiveWooSale(tire));
  if (active.length) {
    const lines = active.map(tire => {
      const regular = tire.regularPrice && tire.regularPrice !== tire.salePrice
        ? (english ? ` (regular $${tire.regularPrice})` : ` (regular $${tire.regularPrice})`)
        : '';
      return `• ${tire.name} — $${tire.salePrice}/${english ? 'tire' : 'llanta'}${regular} | ${tire.stock} ${english ? 'in stock' : 'en stock'}`;
    });
    return `${english ? 'Current promotion:' : 'Promoción vigente:'}\n\n${lines.join('\n')}`;
  }

  if (candidates.length) {
    const tire = candidates[0];
    return english
      ? `${tire.name} is no longer on promotion. Its current price is $${tire.price}/tire.`
      : `${tire.name} ya no está en promoción. Su precio actual es $${tire.price}/llanta.`;
  }

  return english
    ? 'That promotion is no longer active. I could not identify the exact tire from your message.'
    : 'Esa promoción ya no está vigente. No pude identificar la llanta exacta en tu mensaje.';
}

function asksOutOfDeliveryZone(text) {
  return /\b(houston|texas|tx|orlando|tampa|jacksonville|georgia|atlanta|new york|ny|california|los angeles)\b/i.test(text)
    && /\b(delivery|deliver|env[ií]o|entrega|llevar|mandar)\b/i.test(text);
}

function wantsAdvisor(text) {
  return /asesor|representante|persona|humano|agente|vendedor|manager|supervisor|advisor|representative|human|salesperson|agent/i.test(text);
}

function outOfDeliveryZoneReply(text='', session=null) {
  if (isEnglishMessage(text, session)) {
    return 'We only offer delivery in the Miami area, and on Thursdays we go up to West Palm Beach.';
  }
  return 'Solo hacemos delivery en el área de Miami, y los jueves vamos hasta West Palm Beach.';
}

function askSizeForPositionReply(position, text='', session=null) {
  if (isEnglishMessage(text, session)) return `What size do you need for ${position}?`;
  const label = position === 'steer' ? 'delantera'
    : position === 'traction' ? 'tracción'
    : position === 'trailer' ? 'trailer'
    : 'esa posición';
  return `¿Qué medida necesitas para ${label}?`;
}

function isSimpleGreeting(text) {
  return /^\s*(hola|buenos dias|buenos días|buenas|buenas tardes|buenas noches|hello|hi|hey|good morning|good afternoon|good evening)\s*[!.?]*\s*$/i.test(text);
}

function isGenericInfoRequest(text) {
  const asksInfo = /quiero.*(?:informaci[oó]n|info)|quisiera.*(?:informaci[oó]n|info)|m[aá]s informaci[oó]n|mas informacion|me das.*(?:informaci[oó]n|info)|can i get.*(?:info|information)|more info|more information/i.test(text);
  if (!asksInfo) return false;
  return !extractTireSize(text)
    && !normalizePosition(text)
    && !wantsFinancing(text)
    && !wantsWholesale(text)
    && !wantsAdvisor(text)
    && !asksOutOfDeliveryZone(text);
}

function initialGreetingReply(text='', session=null) {
  if (isEnglishMessage(text, session)) return "Hi! I'm the Tires Depot virtual assistant. How can I help you?";
  return '¡Hola! Soy el asistente virtual de Tires Depot. ¿Cómo puedo ayudarte?';
}

function withInitialAssistantIntro(reply, text='', isFirstInteraction=false, session=null) {
  if (!isFirstInteraction) {
    return String(reply || '')
      .replace(/^\s*(?:¡?\s*hola|buen(?:os|as)\s+(?:d[ií]as|tardes|noches)|hi|hello)[!,.:\s-]*/i, '')
      .replace(/^\s*(?:soy\s+el\s+asistente\s+virtual\s+de\s+Tires\s+Depot|i(?:'m| am)\s+the\s+Tires\s+Depot\s+virtual\s+assistant)[.!,:;\s-]*/i, '')
      .trim();
  }
  if (/asistente virtual|virtual assistant/i.test(reply)) return reply;
  const intro = isEnglishMessage(text, session)
    ? "Hi! I'm the Tires Depot virtual assistant."
    : '¡Hola! Soy el asistente virtual de Tires Depot.';
  return `${intro}\n\n${reply}`;
}

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
  const entry = {
    key,
    size: session.current.size,
    position: session.current.position,
    origin: session.current.origin,
    brand: session.current.brand,
    tires: session.current.tires,
  };
  if (existing >= 0) session.searches[existing] = entry;
  else session.searches.push(entry);
  session.lastShownSearchKey = entry.key;
  return entry;
}

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      history:       [],
      tires:         [],
      selectedTires: {},
      selectedTiresBySearch: {},
      cartLines: [],
      declinedPositions: {},
      size:          null,
      position:      null,
      pendingPositions: [],
      shownPositions:   [],
      requestedQtyByPosition: {},
      requestedQtyBySearch: {},
      brand:         null,
      name:          null,
      phone:         null,
      email:         null,
      language:      null,
      hasIntroduced: false,
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
- Cobertura de delivery: solo área de Miami. Los jueves vamos hasta West Palm Beach. Fuera de esa cobertura NO ofrezcas delivery, NO ofrezcas "otra opción" y NO preguntes nada más. Si el cliente pide asesor, transfiere a asesor.
- Pago en efectivo (cash): precio normal, sin descuento
- Pago con tarjeta de crédito: recargo del 3% sobre el total
- NO hay descuentos por pagar en efectivo

FINANCIACIÓN:
${FINANCE_OPTIONS.map(f => `- ${f.name}: ${f.note}`).join('\n')}
- Si el cliente pregunta por financiación, cuota inicial, depósito, down payment o "how much down" → muestra las cuatro opciones de financiación y pregunta si necesita financiación.
- Si el cliente dice que necesita financiación, quiere aplicar o pide application → NO preguntes con qué compañía quiere hacer el trámite. El sistema transferirá a un asesor. Después de transferir, termina la conversación: no pidas datos, no retomes búsqueda de llantas, no preguntes nada más.

VENTAS AL POR MAYOR:
- Si el cliente pregunta por compra al por mayor, mayorista, mayoreo, wholesale, flotas o volumen → el sistema transferirá a un asesor. Después de transferir, termina la conversación: no pidas datos, no cotices y no preguntes nada más.

TRANSFERENCIA A ASESOR:
- Cuando transfieras a un asesor, di únicamente: "Te atenderemos a la mayor brevedad posible." En inglés: "An advisor will assist you as soon as possible."
- NUNCA digas "en un momento", "enseguida", "en seguida", "pronto", "pronto te atenderemos", "one moment", "shortly" ni frases que prometan atención inmediata.
- Después de transferir a asesor, termina la conversación. No hagas preguntas adicionales.

FLUJO DE CONVERSACIÓN — sigue este orden estricto:

PASO 1 — SALUDO (SIEMPRE PRIMERO):
- Si el cliente solo saluda, el PRIMER mensaje debe aclarar que eres un bot/asistente virtual de Tires Depot, dar una bienvenida breve y preguntar de forma general cómo puedes ayudar. Si el cliente escribe en español: "¡Hola! Soy el asistente virtual de Tires Depot. ¿Cómo puedo ayudarte?" Si escribe en inglés: "Hi! I'm the Tires Depot virtual assistant. How can I help you?" NO pidas el nombre — se obtiene automáticamente del contacto de WhatsApp.
- Si el primer mensaje ya trae intención concreta de llantas pero falta la medida, saluda como asistente virtual y pregunta la medida necesaria.
- Si el primer mensaje trae saludo + medida, saludo + posición, o saludo + medida + posición, ignora el saludo para clasificar la intención y procesa el resto con las mismas reglas: solo medida → busca medida; medida + posición → busca ambas; solo posición → pregunta medida.
- Saluda e identifícate SOLAMENTE en la primera respuesta de la sesión. En todas las respuestas posteriores ve directo al asunto, aunque el cliente salude otra vez o pregunte por precio, pago, inventario, financiación o cualquier otro tema.
- Si la sesión se reinició o no tienes historial interno, NO asumas contexto de mensajes anteriores visibles en WhatsApp. Trata el mensaje como conversación nueva y saluda como asistente virtual. Si el mensaje incluye posición/cantidad pero no medida, pregunta la medida para esa posición.

PASO 2 — TELÉFONO (solo si [NEEDS_PHONE]):
- Si ves [NEEDS_PHONE] en el contexto → pide el número de teléfono antes de continuar

PASO 3 — BÚSQUEDA DE LLANTAS:
- No preguntes por medida ni posición de entrada. Primero deja que el cliente explique qué necesita.
- Si el cliente da SOLO la medida → busca SOLO con la medida, sin preguntar posición antes. Muestra todas las opciones disponibles para esa medida.
- Si el cliente da medida + posición → busca con ambas.
- Si el cliente da SOLO la posición (delantera, steer, trasera, traction, trailer, etc.) y no hay medida → pregunta la medida.
- Si el cliente ya pidió buscar/cotizar llantas pero todavía no dio medida ni posición → pregunta de forma natural qué está buscando. No suenes insistente.
- Cuando el cliente diga 'para atrás' o 'traseras' sin especificar más → pregunta si es Traction o Trailer (son posiciones diferentes).
- Si el cliente pide varias posiciones en un mensaje → muestra primero los resultados de la primera posición, luego busca la siguiente automáticamente.
- Con tamaño + posición → muestra TODOS los resultados de [INVENTORY DATA] en lista numerada
- Si [INVENTORY DATA] dice "Sin resultados" o "No hay stock" → responde que no tenemos llantas de esa medida/posición. NO muestres alternativas, NO inventes marcas, NO repitas búsquedas anteriores.
- Si piden "la más económica" → destaca la #1 (lista ordenada precio asc)
- Si mencionan marca → filtra por esa marca SOLO cuando está claramente asociada a esa posición. Ejemplo: 'Firestone delantera y 8 traseras' → Firestone SOLO para delantera, para traseras NO hay filtro de marca. Si el [INVENTORY DATA] no trae filtro de marca, muestra TODAS las marcas disponibles.
- Si mencionan origen (americanas, vietnamitas, brasileñas, japonesas, indias, camboyanas, etc.) → filtra por el país en el nombre del producto. El filtro de origen aplica SOLO a la búsqueda donde el cliente lo mencionó. Si [INVENTORY DATA] dice 'Sin filtro de origen' → muestra TODAS las marcas disponibles sin filtrar por país, aunque el cliente haya pedido americanas en una búsqueda anterior.
- Cuando el cliente elige llantas para VARIAS POSICIONES → la cotización final debe incluir TODOS los grupos. El tag [BÚSQUEDAS EN SESIÓN] muestra todas las búsquedas. Usa esos datos para presentar una cotización completa con cada grupo detallado y un total general.
- Hay 3 opciones EXCLUYENTES. Cuando el cliente haya seleccionado marca y cantidad → SIEMPRE pregunta ANTES de mostrar la cotización final: "¿Montas con nosotros (-$5/llanta), prefieres delivery gratis en el área de Miami o pasas a recogerlas?"
  1. *Monta con nosotros* → descuento -$5/llanta, incluye monte en cotización, pregunta válvulas ($5/c) y manejo de llantas viejas ($10/c)
  2. *Free delivery* → sin monte, sin descuento de monte, free delivery área de Miami
  3. *Pickup* → sin monte, sin descuento, el cliente recoge en tienda
- NUNCA incluyas monte en la cotización si el cliente no confirmó explícitamente que va a montar.
- Si el cliente dice 'llevarme las gomas', 'paso a buscarlas', 'recoger', 'pickup', 'solo quiero las gomas' → es Pickup.
- Cuando menciones delivery en preguntas o respuestas, SIEMPRE especifica: 'delivery gratis en el área de Miami'. Los jueves también vamos hasta West Palm Beach. Fuera de Miami/West Palm Beach jueves, no ofrezcas nada ni preguntes otra opción.
- SIEMPRE incluye todas las selecciones previas en la cotización final, no solo la última.

MANEJO DE PREGUNTAS FUERA DEL FLUJO (crítico):
- Si el cliente pregunta algo general (monte, válvula, delivery, ubicación) mientras ya hay una búsqueda activa → responde brevemente y LUEGO retoma: si ya mostraste opciones di "Retomando tu búsqueda, ¿cuál de estas opciones prefieres?" y repite la lista COMPLETA de opciones disponibles. NUNCA reduzcas la lista a 3 si originalmente había más opciones. NUNCA pidas de nuevo la medida o posición si ya las tienes.

PASO 4 — CONFIRMACIÓN Y DATOS DEL CLIENTE:
- Después de mostrar cotización final → pregunta: "¿Confirmamos el pedido?"
- Si el cliente confirma → solicita los datos para la factura UNO POR UNO, en mensajes separados y en este orden:
  1. Nombre completo (siempre pedirlo — el nombre de WhatsApp puede ser apodo o empresa, no es confiable)
  2. Empresa (si aplica)
  3. Dirección completa (siempre necesaria para la factura, independientemente de si es pickup, delivery o monte)
  4. Teléfono — ya lo tienes en [CUSTOMER PHONE], no lo pidas
  5. Correo electrónico
- Nunca intentes interpretar un bloque desordenado con todos los datos. Pregunta y guarda un solo campo por turno.
- Después de recibir el correo, pregunta si quiere inscribirse en la lista de correos para recibir información sobre promociones. Cuando responda sí o no, el sistema registra el pedido y esa preferencia en Google Sheets; después agradece y cierra según la modalidad. NO vuelvas a preguntar "¿Confirmamos el pedido?".
- Cierra con una frase según la modalidad:
  - Pickup → "Puedes pasar a recoger tu pedido en *12301 NW 116th Ave, Suite 106, Medley FL 33178* en horario Lun–Vie 9am–5pm | Sáb 9am–1pm."
  - Delivery → "Tu pedido será entregado en la dirección indicada. Te avisamos cuando salga."
  - Monte → "Puedes traer tu vehículo a *9710 NW 114 Way Bay#1, Medley FL 33178* en horario Lun–Vie 9am–5pm | Sáb 9am–1pm. Sin cita previa."
- NUNCA digas "te contactaremos" ni "nos comunicaremos contigo".

PASO 5 — OFERTA DE EMAIL (solo si [OFFER_EMAIL]):
- Después de mostrar cotización o resultados, si ves [OFFER_EMAIL] → invita al cliente a registrar su email para recibir la *Llanta de la Semana* con precios especiales. Hazlo de forma breve y no invasiva. Si dice que no → acepta y continúa normalmente.

FORMATO LISTA:
N. *Producto exacto* — $precio/llanta | stock unidades | Posición
No incluyas precio de monte en las opciones de llantas. El precio de monte se muestra solo después si el cliente elige montar con nosotros.
Después pregunta cuántas llantas necesita y cómo prefiere recibirlas. Hay 3 opciones EXCLUYENTES:
1. Monta con nosotros → descuento -$5/llanta, pregunta válvulas y disposición de llantas viejas
2. Delivery gratis → área de Miami, sin descuento, sin preguntar disposición
3. Pickup → pasa a recoger al local, sin descuento, sin delivery

ESTILO:
- Responde en el mismo idioma del cliente. Español por defecto. Inglés solo si el mensaje completo del cliente está claramente en inglés. Si el cliente escribe en español pero menciona un nombre propio en inglés como "American First Finance", responde en español.
- Las palabras técnicas "steer", "traction", "trailer", "front", "rear" o "drive" NO cambian el idioma por sí solas. Si la conversación viene en español y el cliente responde "steer", "traction" o "trailer", sigue respondiendo en español.
- Cuando preguntes por posición en español, usa español primero: "delantera/direccional", "tracción/trasera" o "trailer/remolque". No hagas la pregunta principal en inglés como "Steer o Traction" si el cliente viene hablando español.
- ULTRA CORTO. Frases sueltas. Máximo 2 líneas. Sin cortesías, sin introducciones, sin despedidas.
- Tono consultivo, no pushy. No conviertas cada mensaje en "¿qué medida?" o "¿qué posición?". Haz esas preguntas solo cuando sean necesarias para ayudar.
- UNA SOLA PREGUNTA POR MENSAJE. Nunca combines dos preguntas en el mismo mensaje. Primero resuelve la selección de llanta, LUEGO (en el siguiente mensaje) pregunta la modalidad de entrega.
- Si tienes [INVENTORY DATA] → lista TODOS los productos numerados inmediatamente, sin preámbulo ni frases como 'tengo disponibles' o 'aquí están'. NUNCA digas 'voy a buscar' o 'espera que busco' si ya tienes [INVENTORY DATA] — la búsqueda YA se realizó. Muestra la lista directamente.
- Al listar inventario, conserva EXACTAMENTE el nombre, precio, stock, posición y orden que vienen en [INVENTORY DATA]. No resumas el nombre a solo marca. No cambies Firestone/Jet Way/Pirelli/Continental por otras marcas. No cambies precios ni stock.
- Nunca copies literalmente "[INVENTORY DATA]" ni ningún tag interno en la respuesta al cliente.
- Sin resultados para la marca exacta → revisa si hay otro modelo de esa marca en la lista. Si SÍ hay → di 'No tenemos ese modelo específico pero sí tenemos [marca] en [modelo alternativo]' y ponlo primero. Si NO hay → di que no hay esa marca y muestra las alternativas disponibles. No esperes a que el cliente pregunte.
- Nunca inventes inventario — solo usa [INVENTORY DATA]
- Si el cliente dice cuántas llantas de cada posición necesita (ej: "2 steer y 8 traction") → muestra primero los resultados de una posición y luego di que buscarás la otra. No preguntes confirmaciones innecesarias.
- Cuando el cliente responda con un número después de ver una lista de opciones, interpreta ese número como la SELECCIÓN de esa opción (ej: responde "2" → elige la opción #2 de la lista), NO como cantidad. La cantidad ya se conoce del mensaje inicial.
- Si responde con número + marca/modelo (ej: "8 Sunfull"), el número es la CANTIDAD y la marca/modelo es la SELECCIÓN. Guarda ambos datos en la posición de la lista mostrada.
- "Radial" o "radiales" describe la construcción de la llanta; NO es una medida ni una posición. Si dice "2 radiales", conserva cantidad 2 y pregunta la medida si no existe en sesión; si ya existe, pregunta para qué posición las necesita. No ejecutes una búsqueda general.
- Si hay varias posiciones pendientes: muestra las opciones de una posición → espera que el cliente elija → confirma su elección → ENTONCES muestra las opciones de la siguiente posición. NO asumas ninguna selección que el cliente no haya hecho explícitamente.
- Si una posición tiene varias opciones (ej: 2 Firestone diferentes), el cliente DEBE elegir cuál antes de continuar. No tomes la primera por defecto.
- Steer, traction, trailer y all position son posiciones independientes. Antes de pedir modalidad, cotizar o confirmar, debe existir una selección propia para CADA posición consultada. "All position" NUNCA significa trailer.
- Un pedido puede contener múltiples líneas con diferentes tamaños, posiciones y marcas, incluso dos productos distintos de la misma posición. Conserva cada combinación seleccionada con su propia cantidad; nunca reemplaces una línea anterior solo porque comparte posición o tamaño.
- Después de completar una línea, pregunta si quiere agregar algo más o ver su pedido. Al mostrar el carrito, permite agregar o quitar líneas. Solo cuando el cliente confirme que el carrito está correcto pregunta por monte, delivery o pickup y genera la cotización.
- Si el cliente descarta una posición (por ejemplo, consiguió las steer más baratas en otro lugar), márcala como descartada: no vuelvas a pedir una elección para esa posición y no la incluyas en la cotización. Continúa únicamente con las posiciones que sí comprará.
- No adivines cambios ambiguos del carrito. Para agregar o quitar productos, el cliente debe identificar claramente la línea, marca, producto o posición. Si no está claro, pide que lo especifique.
- Cuando haya una posición pendiente y el cliente rechace todas sus opciones con lenguaje natural, el clasificador de intención puede marcar esa posición como descartada. Si la intención no es clara, no cambies el carrito.
- Las promociones se verifican directamente con los campos vigentes de WooCommerce (on_sale, precio regular, precio de oferta y fechas). Si preguntan por una promoción anterior que ya terminó, informa que ya no está vigente y da el precio actual. Nunca conserves una promoción por memoria de la conversación.

IMPORTANTE: Los tags [INVENTORY DATA:], [QUOTE:], [CUSTOMER NAME:], etc. son instrucciones internas — NUNCA los copies literalmente en tu respuesta al cliente. Usa su contenido para formular tu respuesta.
CRÍTICO — COTIZACIONES: El tag [QUOTE:] contiene la cotización oficial calculada por el sistema.
- Si hay [QUOTE:] → reproduce su contenido TEXTUALMENTE, línea por línea, sin cambiar ningún número ni el formato. No reformatees. No recalcules. No "simplifiques".
- El tax en [QUOTE:] es SIEMPRE correcto (7% sobre el total de llantas). No lo recalcules.
- Si no hay [QUOTE:] → NO inventes una cotización. Responde solo con la información disponible.

Tags de contexto:
[SESSION LANGUAGE: es|en] → idioma fijo de esta conversación. Responde siempre en ese idioma aunque el último mensaje tenga palabras técnicas o cortas en otro idioma.
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
  if (typeof session.hasIntroduced !== 'boolean') {
    session.hasIntroduced = session.history.length > 0;
  }
  const isFirstInteraction = !session.hasIntroduced;
  session.hasIntroduced = true;
  if (!session.language) session.language = initialLanguageFromText(text);

  // Migrate old session structure if needed
  if (!session.current) {
    session.current = {
      size: session.size || null,
      position: session.position || null,
      origin: session.origin || null,
      brand: session.brand || null,
      tires: session.tires || [],
      pendingPositions: session.pendingPositions || [],
      shownPositions: session.shownPositions || [],
    };
    session.searches = session.searches || [];
  }
  if (!session.current.tires) session.current.tires = [];
  if (!session.selectedTires) session.selectedTires = {};
  if (!session.selectedTiresBySearch) session.selectedTiresBySearch = {};
  if (!session.cartLines) session.cartLines = [];
  if (!session.requestedQtyBySearch) session.requestedQtyBySearch = {};
  if (!session.declinedPositions) session.declinedPositions = {};
  if (!session.searches) session.searches = [];
  ensureQuantityState(session);

  const declinedNow = [...new Set(extractDeclinedPositions(text))];
  declinedNow.forEach(position => {
    session.declinedPositions[position] = true;
    delete session.selectedTires[position];
    (session.searches || [])
      .filter(search => search.position === position)
      .forEach(search => delete session.selectedTiresBySearch[search.key]);
    session.cartLines = session.cartLines.filter(line => line.position !== position);
    console.log(`[POSITION DECLINED] ${position}`);
  });
  const isPositionDeclineMessage = declinedNow.length > 0;

  // WhatsApp: phone is the userId directly
  if (isWA && !session.phone) session.phone = userId;

  if (isFirstInteraction && (isSimpleGreeting(text) || isGenericInfoRequest(text))) {
    const reply = initialGreetingReply(text, session);
    session.step = 'searching';
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    return reply;
  }

  if (session.conversationEnded) {
    const reply = advisorHandoffReply(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  if (wantsAdvisor(text)) {
    session.conversationEnded = true;
    const reply = advisorHandoffReply(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    console.log(`[ADVISOR HANDOFF] phone=${session.phone || userId} text="${text.substring(0,80)}"`);
    return reply;
  }

  if (asksOutOfDeliveryZone(text)) {
    const reply = outOfDeliveryZoneReply(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    console.log(`[OUT OF DELIVERY ZONE] phone=${session.phone || userId} text="${text.substring(0,80)}"`);
    return reply;
  }

  if (wantsWholesale(text)) {
    session.conversationEnded = true;
    session.wholesaleTransferRequested = true;
    const reply = advisorHandoffReply(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    console.log(`[WHOLESALE HANDOFF] phone=${session.phone || userId} text="${text.substring(0,80)}"`);
    return reply;
  }

  // Financing flow is deterministic: info first, advisor handoff only if needed.
  if (wantsFinancingHandoff(text, session)) {
    session.awaitingFinanceNeedAnswer = false;
    session.financeTransferRequested = true;
    session.conversationEnded = true;
    const reply = financingAdvisorReply(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    console.log(`[FINANCE HANDOFF] phone=${session.phone || userId} text="${text.substring(0,80)}"`);
    return reply;
  }

  if (wantsFinancing(text)) {
    session.awaitingFinanceNeedAnswer = true;
    const reply = financingInfoReply(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    console.log(`[FINANCE INFO] phone=${session.phone || userId} text="${text.substring(0,80)}"`);
    return reply;
  }

  if (asksAboutTirePromotion(text)) {
    try {
      const inventory = await fetchAllInventory(true);
      const reply = promotionReply(inventory, text, session);
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    } catch (err) {
      console.error('Promotion lookup error:', err.message);
      const reply = isEnglishMessage(text, session)
        ? 'I could not verify the current promotion right now. Please try again shortly.'
        : 'No pude verificar la promoción vigente en este momento. Inténtalo nuevamente en unos minutos.';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
  }

  const wantsCartReview = /mu[eé]strame|mostrar?|ver (?:el |mi )?(?:pedido|carrito)|revisar? (?:el |mi )?(?:pedido|carrito)|eso es todo|nada m[aá]s|no necesito m[aá]s|show (?:my |the )?(?:order|cart)|checkout|that's all|nothing else/i.test(text);
  const wantsCartAddition = /agrega|agregar|añade|añadir|algo m[aá]s|otra llanta|otras llantas|add|another tire|more tires/i.test(text);
  const wantsCartRemoval = /quita|quitar|elimina|eliminar|saca|sacar|remove|delete/i.test(text);
  const confirmsCart = /^(?:s[ií]|yes|correcto|est[aá] bien|todo correcto|as[ií] est[aá] bien|confirmo|ok|okay|dale)[.! ]*$/i.test(text);
  const mentionsKnownBrand = KNOWN_BRANDS.some(brand => text.toLowerCase().includes(brand.toLowerCase()));

  if (session.awaitingCartAction) {
    if (wantsCartRemoval) {
      const removed = removeCartLine(session, text);
      const reply = removed
        ? `${cartSummary(session, text)}\n\n${cartReviewQuestion(text, session)}`
        : `${cartSummary(session, text)}\n\n${isEnglishMessage(text, session) ? 'Tell me which line number or brand you want to remove.' : 'Dime qué número de línea o marca quieres quitar.'}`;
      session.awaitingCartAction = false;
      session.awaitingCartConfirmation = true;
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    if (wantsCartReview) {
      session.awaitingCartAction = false;
      session.awaitingCartConfirmation = true;
      const reply = `${cartSummary(session, text)}\n\n${cartReviewQuestion(text, session)}`;
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    if (wantsCartAddition && !extractTireSize(text) && !normalizePosition(text) && !mentionsKnownBrand) {
      session.awaitingCartAction = false;
      const reply = isEnglishMessage(text, session)
        ? 'What tire size or position would you like to add?'
        : '¿Qué medida o posición quieres agregar?';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    if (!extractTireSize(text) && !normalizePosition(text) && !mentionsKnownBrand) {
      const reply = cartActionQuestion(text, session);
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    session.awaitingCartAction = false;
  }

  if (session.awaitingCartConfirmation) {
    if (wantsCartRemoval) {
      const removed = removeCartLine(session, text);
      const reply = removed
        ? `${cartSummary(session, text)}\n\n${cartReviewQuestion(text, session)}`
        : `${cartSummary(session, text)}\n\n${isEnglishMessage(text, session) ? 'Tell me which line number or brand you want to remove.' : 'Dime qué número de línea o marca quieres quitar.'}`;
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    if (confirmsCart) {
      if (!(session.cartLines || []).some(line => line.tire && line.qty)) {
        session.awaitingCartConfirmation = false;
        const reply = isEnglishMessage(text, session)
          ? 'Your cart is empty. What tire size or position would you like to add?'
          : 'Tu carrito está vacío. ¿Qué medida o posición quieres agregar?';
        session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
        if (session.history.length > 6) session.history = session.history.slice(-6);
        return reply;
      }
      session.awaitingCartConfirmation = false;
      session.cartConfirmed = true;
      const reply = isEnglishMessage(text, session)
        ? 'Will you mount with us (-$5/tire), use free delivery in the Miami area, or pick them up?'
        : '¿Montas con nosotros (-$5/llanta), prefieres delivery gratis en el área de Miami o pasas a recogerlas?';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    if (wantsCartAddition && !extractTireSize(text) && !normalizePosition(text) && !mentionsKnownBrand) {
      session.awaitingCartConfirmation = false;
      const reply = isEnglishMessage(text, session)
        ? 'What tire size or position would you like to add?'
        : '¿Qué medida o posición quieres agregar?';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    if (!extractTireSize(text) && !normalizePosition(text) && !mentionsKnownBrand) {
      const reply = `${cartSummary(session, text)}\n\n${cartReviewQuestion(text, session)}`;
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    session.awaitingCartConfirmation = false;
  }

  if (asksToRepeatInventoryOptions(text)) {
    const reply = buildExactInventoryReplyFromSearches(session, text);
    if (reply) {
      session.history.push({ role: 'user', content: text });
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      console.log(`[REPEAT INVENTORY EXACT ${BOT_VERSION}] phone=${session.phone || userId}`);
      return reply;
    }
  }

  const confirmsOrder = /^(?:s[ií]|yes|confirmo|confirmamos|correcto|de acuerdo|ok|okay|dale)[.! ]*$/i.test(text);
  if (session.awaitingOrderConfirmation && confirmsOrder) {
    session.awaitingOrderConfirmation = false;
    session.awaitingInvoiceData = true;
    session.invoiceData = {};
    session.invoiceField = 'name';
    const reply = isEnglishMessage(text, session)
      ? 'What is the full name for the invoice?'
      : '¿Cuál es el nombre completo para la factura?';
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  // Name comes from WhatsApp contact — no need to ask

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

  // ── Capture invoice data one field at a time ──────────────────────────────
  if (session.awaitingInvoiceData) {
    const english = isEnglishMessage(text, session);
    session.invoiceData = session.invoiceData || {};

    if (session.invoiceField === 'name') {
      session.invoiceData.name = text;
      session.name = text;
      session.invoiceField = 'company';
      const reply = english ? 'What is the company name? Reply "none" if it does not apply.' : '¿Cuál es el nombre de la empresa? Responde "no" si no aplica.';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }

    if (session.invoiceField === 'company') {
      session.invoiceData.company = /^(?:no|ninguna|no aplica|n\/?a|none|not applicable)$/i.test(text) ? '' : text;
      session.invoiceField = 'address';
      const reply = english ? 'What is the full billing address?' : '¿Cuál es la dirección completa para la factura?';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }

    if (session.invoiceField === 'address') {
      session.invoiceData.address = text;
      session.invoiceField = 'email';
      const reply = english ? 'What is the email address?' : '¿Cuál es el correo electrónico?';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }

    const emailInText = extractEmail(text);
    if (!emailInText) {
      const reply = english ? 'Please send a valid email address.' : 'Envíame un correo electrónico válido.';
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    session.invoiceData.email = emailInText;
    session.email = emailInText;
    session.orderEmail = emailInText;

    const orderLines  = session.confirmedOrderLines || 'ver cotización';
    const orderModal  = session.confirmedModalidad  || session.modalidad || 'pendiente';
    const orderTotal  = session.lastQuoteTotal
      ? '$' + parseFloat(session.lastQuoteTotal).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})
      : '';

    session.pendingOrder = {
      name:      session.invoiceData.name,
      company:   session.invoiceData.company,
      address:   session.invoiceData.address,
      phone:     session.phone || userId,
      email:     emailInText,
      order:     orderLines,
      total:     orderTotal,
      modalidad: orderModal,
    };
    session.awaitingInvoiceData = false;
    session.invoiceField = null;
    console.log(`[ORDER CONFIRMED] name=${session.invoiceData.name} order=${orderLines} total=${orderTotal} modalidad=${orderModal}`);

    session.awaitingPromoAnswer = true;
    const reply = english
      ? 'Would you like to join our email list to receive information about promotions?'
      : '¿Quieres inscribirte en nuestra lista de correos para recibir información sobre promociones?';
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  // ── Detect promo subscription consent ────────────────────────────────────
  const acceptedPromo = /\bsi\b|\byes\b|claro|dale|por supuesto|me apunto|suscrib|quiero|\bok\b|bueno/i.test(text);
  const declinedPromo = /\bno\b|no gracias|paso/i.test(text);
  if (session.awaitingPromoAnswer && session.pendingOrder && !session.promoAnswered) {
    if (acceptedPromo || declinedPromo) {
      const promoVal = acceptedPromo ? 'si' : 'no';
      const saved = await logOrderToSheet({
        ...session.pendingOrder,
        promo: promoVal,
      });
      if (!saved) {
        const reply = isEnglishMessage(text, session)
          ? 'I could not save the order information. Please try again shortly.'
          : 'No pude guardar los datos del pedido. Por favor, inténtalo nuevamente en unos minutos.';
        session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
        if (session.history.length > 6) session.history = session.history.slice(-6);
        return reply;
      }
      session.awaitingPromoAnswer = false;
      session.promoAnswered = true;
      session.logged = true;
      session.orderCompleted = true;
      console.log(`[SHEET WRITE] ${session.pendingOrder.name} | promo=${promoVal}`);
      const reply = completedOrderReply(session.pendingOrder.modalidad, text, session);
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    const reply = isEnglishMessage(text, session)
      ? 'Please answer yes or no. Would you like to join our email list for promotions?'
      : 'Responde sí o no. ¿Quieres inscribirte en nuestra lista de correos para recibir promociones?';
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  // ── Detect delivery modalidad ────────────────────────────────────────────
  if (/\bmonte\b|\bmontar\b|monta con nosotros/i.test(text) && !/sin monte|no monte/i.test(text)) {
    session.modalidad = 'monte';
  } else if (/\bdelivery\b|\benvio\b|\benvío\b|\bdeliver\b/i.test(text)) {
    session.modalidad = 'delivery';
  } else if (/recoger|pickup|\bpaso\b|paso a buscar|me las llevo|llevarme|solo quiero las gomas|solo quiero llevarme/i.test(text)) {
    session.modalidad = 'pickup';
  }
  if (session.modalidad) console.log(`[MODALIDAD] ${session.modalidad} | "${text.substring(0,50)}"`);

  // ── Detect tire search params ─────────────────────────────────────────────
  const newSize = extractTireSize(text);
  const sizeMatch = newSize ? [newSize] : null;
  const explicitPos = normalizePosition(text);
  const radialQtyMatch = text.match(/\b([1-9][0-9]?)\s+(?:llantas?\s+|gomas?\s+|tires?\s+)?radiales?\b/i);

  if (radialQtyMatch && !explicitPos) {
    session.pendingRadialQty = validRequestedQty(radialQtyMatch[1]);
    const needsSize = !session.current.size;
    session.awaitingRadialSize = needsSize;
    session.awaitingRadialPosition = !needsSize;
    const reply = needsSize
      ? (isEnglishMessage(text, session) ? 'What tire size do you need?' : '¿Qué medida de llanta necesitas?')
      : (isEnglishMessage(text, session)
          ? 'For which position: steer, traction, trailer, or all position?'
          : '¿Para qué posición: direccional, tracción, trailer o all position?');
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  if (session.awaitingRadialSize && newSize && !explicitPos) {
    session.current.size = newSize;
    session.awaitingRadialSize = false;
    session.awaitingRadialPosition = true;
    const reply = isEnglishMessage(text, session)
      ? 'For which position: steer, traction, trailer, or all position?'
      : '¿Para qué posición: direccional, tracción, trailer o all position?';
    session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  if (explicitPos && session.pendingRadialQty) {
    setRequestedQty(session, explicitPos, session.pendingRadialQty);
    session.pendingRadialQty = null;
    session.awaitingRadialSize = false;
    session.awaitingRadialPosition = false;
  }

  if (!newSize && isRimOnlySize(text)) {
    const reply = withInitialAssistantIntro(askPreciseSizeForRimReply(text, session), text, isFirstInteraction, session);
    session.awaitingSizeForPosition = true;
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  if (newSize) {
    session.awaitingOrderConfirmation = false;
    if (session.current.size && newSize !== session.current.size) {
      session.current.origin = null;
    }
    session.current.size = newSize;
    if (!explicitPos && !session.awaitingSizeForPosition) {
      session.current.position = null;
      session.current.pendingPositions = [];
    }
    session.awaitingSizeForPosition = false;
    session.current.step = 'searching';
  }

  // Detect requested quantities. Bare numbers are intentionally ignored here:
  // in this flow they are option indexes unless paired with tire units/position.
  const qtyPosMatches = extractPositionQuantities(text);
  const namedQtyMatch = text.match(/^\s*(?:(?:quiero|necesito|dame|llevo|me llevo|voy a llevar)\s+)?([1-9][0-9]?)\s+(.+?)\s*$/i);
  const tiresForNamedQty = session.current.tires?.length
    ? session.current.tires
    : (getLastSearch(session)?.tires || []);
  const namedQtyTire = namedQtyMatch
    ? tiresForNamedQty.find(tire => {
        const requestedName = normalizeProductText(namedQtyMatch[2]);
        return (tire.brand && requestedName.includes(normalizeProductText(tire.brand)))
          || (tire.name && normalizeProductText(tire.name).includes(requestedName));
      })
    : null;
  const quantityWithNamedSelection = namedQtyTire ? validRequestedQty(namedQtyMatch[1]) : null;
  const generalQty = extractGeneralQuantity(text) || quantityWithNamedSelection;
  let inputConsumedAsQuantity = false;
  if (qtyPosMatches.length > 0) {
    qtyPosMatches.forEach(({ posKey, qty }) => setRequestedQty(session, posKey, qty));
    session.awaitingQuantity = false;
    inputConsumedAsQuantity = true;
    console.log('[QTY BY POSITION]', JSON.stringify(session.requestedQtyByPosition));
  } else if (generalQty) {
    const qtyPositionKey = quantityWithNamedSelection
      ? getSelectionPositionKey(session)
      : (session.current.position || DEFAULT_POSITION_KEY);
    setRequestedQty(session, qtyPositionKey, generalQty, quantityWithNamedSelection ? session.lastShownSearchKey : null);
    session.awaitingQuantity = false;
    inputConsumedAsQuantity = true;
    console.log('[QTY DEFAULT]', JSON.stringify(session.requestedQtyByPosition));
  } else if (session.awaitingQuantity) {
    const bareQty = extractBareQuantity(text);
    if (bareQty) {
      setRequestedQty(session, getSelectionPositionKey(session), bareQty, session.lastShownSearchKey);
      const pendingLine = session.cartLines?.find(line => line.key === session.pendingCartLineKey);
      if (pendingLine) pendingLine.qty = bareQty;
      session.pendingCartLineKey = null;
      session.awaitingQuantity = false;
      inputConsumedAsQuantity = true;
      console.log('[QTY BARE]', JSON.stringify(session.requestedQtyByPosition));
    }
  }

  const pos = explicitPos;
  if (pos) {
    if (!isPositionDeclineMessage) delete session.declinedPositions[pos];
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
  if (pos && !newSize && !session.current.size) {
    const reply = withInitialAssistantIntro(askSizeForPositionReply(pos, text, session), text, isFirstInteraction, session);
    session.awaitingSizeForPosition = true;
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  const brandHit = KNOWN_BRANDS.find(b => text.toLowerCase().includes(b.toLowerCase()));
  if (brandHit) {
    const multiPosition = qtyPosMatches.length > 1;
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
  contactContext += `\n[SESSION LANGUAGE: ${session.language || 'es'}]`;
  if (session.name)  contactContext += `\n[CUSTOMER NAME: ${session.name}]`;
  if (session.phone) contactContext += `\n[CUSTOMER PHONE: ${session.phone}]`;
  if (session.email) contactContext += `\n[CUSTOMER EMAIL: ${session.email}]`;

  let needsPhone = '';
  if (!isWA && session.name && !session.phone && session.step === 'phone') {
    needsPhone = '\n[NEEDS_PHONE]';
  }

  // ── Fetch inventory ───────────────────────────────────────────────────────
  let inventoryContext = '';
  let deterministicReply = '';
  const inventoryReplyParts = [];
  let shownOptionCount = 0;
  const hasNewSearchTrigger = sizeMatch || pos || /all.?position|todas.?posicion/i.test(text) ||
    Object.keys(session.requestedQtyByPosition||{}).some(k =>
      POSITION_KEYWORDS[k]?.some(kw => text.toLowerCase().includes(kw))
    );

  if (session.current.size && session.current.size.length > 3 && hasNewSearchTrigger && !isPositionDeclineMessage) {
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
        const list = tires.map((t,i) => formatInventoryOption(t, i, isTruck)).join('\n');
        console.log(`[INVENTORY DIRECT ${BOT_VERSION}] ${tires.map(t => `${t.name}=$${t.price}/${t.stock}`).join(' | ')}`);
        const brandLabel  = session.current.brand  ? ` | Marca: ${session.current.brand}` : '';
        const originLabel = session.current.origin ? ` | Origen: ${session.current.origin}` : ' | Sin filtro de origen (mostrar todas las marcas disponibles)';
        inventoryContext = `\n\n[INVENTORY DATA: ${tires.length} llanta(s) para ${session.current.size}${posLabel}${brandLabel}${originLabel} ${mountNote}${cheapLabel}:\n${list}]`;
        inventoryReplyParts.push(list);
        shownOptionCount += tires.length;
        const qtyKey = session.current.position || DEFAULT_POSITION_KEY;
        if (!session.requestedQtyByPosition[qtyKey] && !session.requestedQtyByPosition[DEFAULT_POSITION_KEY]) {
          session.awaitingQuantity = true;
        }

        if (session.current.position) {
          session.current.shownPositions.push(session.current.position);
          session.lastShownPositions = [...session.current.shownPositions]; // persist
        }

        // Save current (first) position search before moving to pending
        saveCurrentSearch(session);

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
            const nextList = nextTires.map((t,i) => formatInventoryOption(t, i, isTruckNext)).join('\n');
            inventoryContext += `\n\n[INVENTORY DATA POSICIÓN ${nextPos.toUpperCase()}: ${nextTires.length} llanta(s):\n${nextList}]`;
            inventoryReplyParts.push(nextList);
            shownOptionCount += nextTires.length;
            session.current.tires = nextTires;
          }
          if (session.current.position) {
          session.current.shownPositions.push(session.current.position);
          session.lastShownPositions = [...session.current.shownPositions]; // persist
        }
          // Save each pending position separately
          saveCurrentSearch(session);
        }

        if (!session.current.pendingPositions || session.current.pendingPositions.length === 0) {
          session.current.position = null;
          session.current.origin   = null;
          session.current.brand    = null;
        }

        // Lead logged only when order is confirmed with full customer data
        deterministicReply = `${inventoryReplyParts.join('\n\n')}\n\n${inventoryFollowupQuestion(shownOptionCount, text, session)}`;

      } else if (brandForSearch) {
        // No results with brand — retry without brand to show alternatives
        const isTruckRetry = getRimSize(session.current.size) >= 22.5;
        const tiresNoBrand = filterTires(session.current.size, session.current.position, null, session.current.origin);
        if (tiresNoBrand.length > 0) {
          session.current.tires = tiresNoBrand;
          const list = tiresNoBrand.map((t,i) => formatInventoryOption(t, i, isTruckRetry)).join('\n');
          const brandInAlts = tiresNoBrand.some(t => (t.brand||'').toLowerCase() === brandForSearch.toLowerCase());
          const altNote = brandInAlts
            ? `No hay ${brandForSearch} en ese modelo exacto, pero SÍ hay OTRO MODELO de ${brandForSearch} en la lista — DESTÁCALO PRIMERO. Otras marcas también disponibles.`
            : `No hay ${brandForSearch} disponible en esa medida/posición. Muestra alternativas.`;
          inventoryContext = `\n\n[INVENTORY DATA: ${altNote} Opciones en ${session.current.size}${session.current.position?' pos:'+session.current.position:''} (${tiresNoBrand.length}):\n${list}]`;
          inventoryReplyParts.push(list);
          shownOptionCount += tiresNoBrand.length;
          const qtyKey = session.current.position || DEFAULT_POSITION_KEY;
          if (!session.requestedQtyByPosition[qtyKey] && !session.requestedQtyByPosition[DEFAULT_POSITION_KEY]) {
            session.awaitingQuantity = true;
          }
        } else {
          session.current.tires = [];
          session.awaitingQuantity = false;
          inventoryContext = `\n\n[INVENTORY DATA: Sin resultados para ${session.current.size}${session.current.position?' pos:'+session.current.position:''}. No hay stock de esa medida/posición.]`;
          deterministicReply = noStockReply(session.current.size, text, session);
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
            const nextList = nextTires.map((t,i) => formatInventoryOption(t, i, isTruckNext)).join('\n');
            inventoryContext += `\n\n[INVENTORY DATA POSICIÓN ${nextPos.toUpperCase()}: ${nextTires.length} llanta(s):\n${nextList}]`;
            inventoryReplyParts.push(nextList);
            shownOptionCount += nextTires.length;
            session.current.tires = nextTires;
          }
          if (session.current.position) session.current.shownPositions.push(session.current.position);
        }

        // Clear brand/origin after processing all positions
        session.current.position = null;
        session.current.origin   = null;
        session.current.brand    = null;
        session.current.brandOnlyForCurrent = false;
        if (inventoryReplyParts.length > 0) {
          deterministicReply = `${inventoryReplyParts.join('\n\n')}\n\n${inventoryFollowupQuestion(shownOptionCount, text, session)}`;
        }

      } else {
        session.current.tires = [];
        session.awaitingQuantity = false;
        inventoryContext = `\n\n[INVENTORY DATA: Sin resultados para ${session.current.size}${session.current.position?' pos:'+session.current.position:''}. No hay stock de esa medida/posición.]`;
        deterministicReply = noStockReply(session.current.size, text, session);
      }
    } catch (err) {
      console.error('Inventory fetch error:', err.message);
      inventoryContext = `\n\n[INVENTORY DATA: Error al obtener inventario. Invita a continuar por este mismo chat.]`;
    }
  }

  if (deterministicReply) {
    deterministicReply = withInitialAssistantIntro(deterministicReply, text, isFirstInteraction, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: deterministicReply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    console.log(`[DETERMINISTIC REPLY ${BOT_VERSION}] size=${session.current.size} text="${text.substring(0,80)}"`);
    return deterministicReply;
  }

  // ── Tire selection — runs unconditionally before quote generation ──────────
  const _availForSelection = session.current.tires.length > 0
    ? session.current.tires
    : (getLastSearch(session)?.tires || []);
  const selectedOption = inputConsumedAsQuantity && !quantityWithNamedSelection
    ? null
    : findSelection(text, _availForSelection);
  if (selectedOption) {
    const posKey = getSelectionPositionKey(session);
    const selectionSearch = session.searches.find(search => search.key === session.lastShownSearchKey)
      || getLastSearch(session);
    session.awaitingOrderConfirmation = false;
    session.selectedTires[posKey] = selectedOption.tire;
    if (selectionSearch) {
      session.selectedTiresBySearch[selectionSearch.key] = selectedOption.tire;
      const explicitQty = session.requestedQtyBySearch[selectionSearch.key]
        || session.requestedQtyByPosition[posKey]
        || session.requestedQtyByPosition[DEFAULT_POSITION_KEY]
        || null;
      const lineKey = `${selectionSearch.key}|${selectedOption.tire.id || selectedOption.tire.name}`;
      const existingLine = session.cartLines.find(line => line.key === lineKey);
      if (existingLine) {
        if (explicitQty) existingLine.qty = explicitQty;
      } else {
        session.cartLines.push({
          key: lineKey,
          searchKey: selectionSearch.key,
          size: selectionSearch.size,
          position: selectionSearch.position,
          tire: selectedOption.tire,
          qty: explicitQty,
        });
      }
      session.pendingCartLineKey = explicitQty ? null : lineKey;
    }
    console.log(`[SELECTION] posKey=${posKey} tire=${selectedOption.tire.brand} idx=${selectedOption.idx} kind=${selectedOption.kind}`);

    let pendingSearch = getNextUnselectedSearch(session);
    while (pendingSearch?.tires?.length === 1) {
      const pendingPosKey = pendingSearch.position || DEFAULT_POSITION_KEY;
      session.selectedTires[pendingPosKey] = pendingSearch.tires[0];
      session.selectedTiresBySearch[pendingSearch.key] = pendingSearch.tires[0];
      const autoQty = session.requestedQtyBySearch[pendingSearch.key]
        || session.requestedQtyByPosition[pendingPosKey]
        || session.requestedQtyByPosition[DEFAULT_POSITION_KEY]
        || null;
      const autoLineKey = `${pendingSearch.key}|${pendingSearch.tires[0].id || pendingSearch.tires[0].name}`;
      if (!session.cartLines.some(line => line.key === autoLineKey)) {
        session.cartLines.push({
          key: autoLineKey,
          searchKey: pendingSearch.key,
          size: pendingSearch.size,
          position: pendingSearch.position,
          tire: pendingSearch.tires[0],
          qty: autoQty,
        });
      }
      if (!autoQty) session.pendingCartLineKey = autoLineKey;
      console.log(`[AUTO SELECTION] posKey=${pendingPosKey} tire=${pendingSearch.tires[0].brand}`);
      pendingSearch = getNextUnselectedSearch(session);
    }
    if (pendingSearch) {
      session.current.tires = pendingSearch.tires;
      session.current.position = pendingSearch.position;
      session.current.shownPositions = [pendingSearch.position || DEFAULT_POSITION_KEY];
      session.lastShownPositions = [...session.current.shownPositions];
      session.lastShownSearchKey = pendingSearch.key;
      const reply = pendingPositionSelectionReply(pendingSearch, text, session);
      session.history.push({ role: 'user', content: text });
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
  }

  const asksCashOrCardPrice = /\b(?:cash|efectivo|contado|tarjeta|credit card)\b/i.test(text)
    && /\b(?:precio|costo|descuento|cambia|mismo|recargo|price|discount|different|change|fee)\b/i.test(text);
  if (asksCashOrCardPrice) {
    const hasSelectedTire = Object.values(session.selectedTires || {}).some(Boolean);
    const baseReply = isEnglishMessage(text, session)
      ? 'The tire price is the same when paying cash or by card. Credit-card payments have a 3% surcharge; cash has no additional discount.'
      : 'El precio de la llanta es el mismo pagando en efectivo o con tarjeta. Los pagos con tarjeta de crédito tienen un recargo del 3%; en efectivo no hay descuento adicional.';
    const selectionQuestion = isEnglishMessage(text, session)
      ? 'Which tire option do you prefer?'
      : '¿Cuál opción de llanta prefieres?';
    const reply = hasSelectedTire ? baseReply : `${baseReply}\n\n${selectionQuestion}`;
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  if (!selectedOption) {
    let pendingSearch = getNextUnselectedSearch(session);
    if (pendingSearch) {
      const pendingAction = await classifyPendingPositionReply(
        text,
        pendingSearch.position,
        session.language || 'es'
      );
      if (pendingAction === 'decline') {
        const declinedPosition = pendingSearch.position || DEFAULT_POSITION_KEY;
        session.declinedPositions[declinedPosition] = true;
        delete session.selectedTires[declinedPosition];
        delete session.selectedTiresBySearch[pendingSearch.key];
        session.cartLines = session.cartLines.filter(line => line.position !== pendingSearch.position);
        console.log(`[AI POSITION DECLINED] ${declinedPosition}`);
        pendingSearch = getNextUnselectedSearch(session);
        if (!pendingSearch && session.cartLines.some(line => line.tire && line.qty)) {
          session.awaitingCartAction = true;
          const reply = cartActionQuestion(text, session);
          session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
          if (session.history.length > 6) session.history = session.history.slice(-6);
          return reply;
        }
      }
    }
    if (pendingSearch) {
      session.current.tires = pendingSearch.tires;
      session.current.position = pendingSearch.position;
      session.current.shownPositions = [pendingSearch.position || DEFAULT_POSITION_KEY];
      session.lastShownPositions = [...session.current.shownPositions];
      session.lastShownSearchKey = pendingSearch.key;
      const reply = pendingPositionSelectionReply(pendingSearch, text, session);
      session.history.push({ role: 'user', content: text });
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
  }
  if (selectedOption || inputConsumedAsQuantity) {
    const missingQtyLine = session.cartLines.find(line => !line.qty);
    if (missingQtyLine) {
      const missingSearch = session.searches.find(search => search.key === missingQtyLine.searchKey);
      session.pendingCartLineKey = missingQtyLine.key;
      session.awaitingQuantity = true;
      if (missingSearch) {
        session.lastShownSearchKey = missingSearch.key;
        session.current.position = missingSearch.position;
        session.current.shownPositions = [missingSearch.position || DEFAULT_POSITION_KEY];
        session.lastShownPositions = [...session.current.shownPositions];
      }
      const positionLabel = missingQtyLine.position ? ` ${missingQtyLine.position}` : '';
      const reply = isEnglishMessage(text, session)
        ? `How many ${missingQtyLine.tire.brand} ${missingQtyLine.size}${positionLabel} tires do you need?`
        : `¿Cuántas llantas ${missingQtyLine.tire.brand} ${missingQtyLine.size}${positionLabel} necesitas?`;
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
  }
  if (isPositionDeclineMessage
      && Object.values(session.selectedTires || {}).some(Boolean)
      && !session.modalidad
      && !session.confirmedModalidad) {
    session.awaitingCartAction = true;
    const reply = cartActionQuestion(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  if (selectedOption) {
    const posKey = getSelectionPositionKey(session);
    const selectedSearchKey = session.lastShownSearchKey;
    const hasRequestedQty = !!(
      session.requestedQtyBySearch?.[selectedSearchKey]
      || session.requestedQtyByPosition?.[posKey]
      || session.requestedQtyByPosition?.[DEFAULT_POSITION_KEY]
    );
    if (!hasRequestedQty) {
      session.awaitingQuantity = true;
      const reply = inventoryQuantityQuestion(text, session);
      session.history.push({ role: 'user', content: text });
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
    if (!session.modalidad && !session.confirmedModalidad) {
      session.awaitingCartAction = true;
      const reply = cartActionQuestion(text, session);
      session.history.push({ role: 'user', content: text });
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 6) session.history = session.history.slice(-6);
      return reply;
    }
  }
  if (inputConsumedAsQuantity
      && Object.values(session.selectedTires || {}).some(Boolean)
      && !session.modalidad
      && !session.confirmedModalidad) {
    session.awaitingCartAction = true;
    const reply = cartActionQuestion(text, session);
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: reply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return reply;
  }

  // ── Build quote ───────────────────────────────────────────────────────────
  let quoteContext = '';
  let directQuoteReply = '';
  const wantsQuote = /cuanto|precio|total|costo|quote|how much|desglose|calcul|cotiz/i.test(text);

  const lastSearch = getLastSearch(session);
  const availableTires = session.current.tires.length > 0 ? session.current.tires : (lastSearch ? lastSearch.tires : []);

  // Generate combined quote whenever delivery mode is known and multiple searches exist
  const hasDeliveryChoice = !!(session.confirmedModalidad || session.modalidad);
  const isConfirmationMsg  = !!extractEmail(text); // message with customer data
  const wantsFullQuote = !isConfirmationMsg && (hasDeliveryChoice 
    || /cotiz|total|cuanto|precio|quote|how much|desglose|\bmonte\b|\bmontar\b|delivery|recoger|pickup|paso a|llevarme|envio|envío/i.test(text));
  console.log(`[QUOTE CHECK] wantsFullQuote=${wantsFullQuote} searches=${session.searches?.length} hasDelivery=${hasDeliveryChoice} isConfirm=${isConfirmationMsg} logged=${session.logged}`);
  const relevantSearches = (session.searches || []).filter(search =>
    search.position || !(session.searches || []).some(other =>
      other !== search && other.position && other.size === search.size
    )
  );
  const resolvedSearches = relevantSearches.filter(s => {
    const posKey = s.position || DEFAULT_POSITION_KEY;
    return !!session.selectedTiresBySearch?.[s.key] || !!session.declinedPositions?.[posKey];
  });
  const allSearchesResolved = relevantSearches.length > 0
    && resolvedSearches.length === relevantSearches.length;
  const activeCartLines = (session.cartLines || []).filter(line => line.tire);
  const allCartLinesHaveQty = activeCartLines.length > 0 && activeCartLines.every(line => line.qty);

  if (wantsFullQuote && allSearchesResolved && allCartLinesHaveQty && activeCartLines.length > 1) {
    const combinedLines = ['*COTIZACION COMPLETA*'];
    let grandTotal = 0;
    const mount    = session.modalidad === 'monte';
    const valve    = /válvula|valvula|valve|stem/i.test(text);
    const disposal = /basura|disposal|dispos|llantas viejas/i.test(text);

    let totalTires = 0, totalTax = 0, totalMount = 0;
    session.cartLines.filter(line => line.tire && line.qty).forEach(line => {
      const tire = line.tire;
      const qty = line.qty;
      const position = line.position;
      console.log(`[COMBINED TIRE] search=${line.searchKey} pos=${position || 'default'} using=${tire.brand}`);
      const c = calcTotal(tire, qty, mount, valve, disposal);
      const lineTotal = tire.price * qty;
      totalTires += lineTotal;
      totalTax   += c.tax;
      totalMount += c.mc;
      combinedLines.push(`🛞 *${qty}x ${tire.brand} ${tire.size}${position?' '+position:''}*\n   $${tire.price}/llanta × ${qty} = $${lineTotal.toFixed(2)}`);
    });
    const taxBase = totalTires;
    const computedTax = taxBase * BIZ.taxRate;
    grandTotal = totalTires + computedTax + totalMount;
    combinedLines.push(`   ━━━━━━━━━━━━━━`);
    combinedLines.push(`   Subtotal llantas: $${totalTires.toFixed(2)}`);
    combinedLines.push(`   Tax FL (7%): $${computedTax.toFixed(2)}`);
    if (mount) combinedLines.push(`   Monte: $${totalMount.toFixed(2)}`);
    combinedLines.push(`   ━━━━━━━━━━━━━━`);
    combinedLines.push(`*TOTAL: $${grandTotal.toFixed(2)}*`);
    const modalForQuote = session.modalidad || session.confirmedModalidad;
    if (modalForQuote === 'monte') {
      combinedLines.push(`📍 Centro de servicios: 9710 NW 114 Way Bay#1, Medley FL 33178 | Sin cita previa`);
    } else if (modalForQuote === 'pickup') {
      combinedLines.push(`📦 Pickup en tienda: 12301 NW 116th Ave, Suite 106, Medley FL 33178 | Lun–Vie 9am–5pm | Sáb 9am–1pm`);
    } else {
      combinedLines.push(`🚚 Free delivery — área de Miami`);
    }
    session.lastQuoteTotal = grandTotal.toFixed(2);
    // Snapshot order lines with correct qty/brand at quote time
    session.confirmedOrderLines = session.cartLines
      .filter(line => line.tire && line.qty)
      .map(line => `${line.qty}x ${line.tire.brand} ${line.tire.size}${line.position ? ' ' + line.position : ''}`)
      .join(' | ');
    session.confirmedModalidad = session.modalidad || 'pendiente';
    console.log(`[COMBINED TOTAL] $${session.lastQuoteTotal} | lines=${session.confirmedOrderLines} | modalidad=${session.confirmedModalidad}`);
    const quoteText = combinedLines.join('\n');
    session.lastCombinedQuote = quoteText; // cache for re-injection
    quoteContext = '\n\n[QUOTE — presenta esta cotización al cliente y pregunta si confirma:\n' + quoteText + ']';
    directQuoteReply = `${quoteText}\n\n${isEnglishMessage(text, session) ? 'Do you confirm the order?' : '¿Confirmamos el pedido?'}`;

  } else if (availableTires.length > 0 && hasDeliveryChoice && (selectedOption || Object.values(session.selectedTires || {}).some(Boolean))) {
    const posKey = getSelectionPositionKey(session);
    const quoteSearch = session.searches.find(search => search.key === session.lastShownSearchKey)
      || getLastSearch(session);
    const tire   = (quoteSearch && session.selectedTiresBySearch?.[quoteSearch.key]) || selectedOption?.tire;
    const qty    = getRequestedQty(session, posKey, quoteSearch?.key);
    const mount    = session.modalidad === 'monte';
    const valve    = /válvula|valvula|valve|stem/i.test(text);
    const disposal = /basura|disposal|dispos|llantas viejas|old tires/i.test(text);
    if (qty >= 1 && qty <= 24) {
      const quoteStr = formatQuote(tire, qty, mount);
      // Extract total from quote for later logging
      const totalMatch = quoteStr.match(/TOTAL: \$([\d.]+)/);
      if (totalMatch) session.lastQuoteTotal = totalMatch[1];
      quoteContext = `\n\n[QUOTE:\n${quoteStr}]`;
      session.confirmedOrderLines = `${qty}x ${tire.brand} ${tire.size}`;
      session.confirmedModalidad = session.modalidad;
      directQuoteReply = `${quoteStr}\n\n${isEnglishMessage(text, session) ? 'Do you confirm the order?' : '¿Confirmamos el pedido?'}`;
    }
  }

  // Re-inject cached quote if delivery known, no new quote generated, and order not yet confirmed
  if (!quoteContext && allSearchesResolved && (session.confirmedModalidad || session.modalidad) && session.lastCombinedQuote && !session.logged && !session.promoAnswered && !isConfirmationMsg) {
    quoteContext = '\n\n[QUOTE:\n' + session.lastCombinedQuote + ']';
    directQuoteReply = `${session.lastCombinedQuote}\n\n${isEnglishMessage(text, session) ? 'Do you confirm the order?' : '¿Confirmamos el pedido?'}`;
    console.log('[QUOTE REINJECTED]');
  }

  if (directQuoteReply) {
    session.awaitingOrderConfirmation = true;
    session.history.push({ role: 'user', content: text });
    session.history.push({ role: 'assistant', content: directQuoteReply });
    if (session.history.length > 6) session.history = session.history.slice(-6);
    return directQuoteReply;
  }

  // ── Email offer ───────────────────────────────────────────────────────────
  let emailOffer = '';
  if (!session.emailOffered && !session.email && quoteContext) {
    emailOffer = '\n[OFFER_EMAIL]';
    session.emailOffered = true;
  }

  // ── Searches summary ──────────────────────────────────────────────────────
  const searchesSummary = '';

  // ── Send assistant request ────────────────────────────────────────────────
  const userMessage = text + contactContext + needsPhone + searchesSummary + inventoryContext + quoteContext + emailOffer;

  session.history.push({ role:'user', content: userMessage });
  if (session.history.length > 6) session.history = session.history.slice(-6);

  // step management — no longer ask for name

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system:     SYSTEM_PROMPT,
    messages:   session.history,
  });

  const reply = withInitialAssistantIntro(response.content[0].text, text, isFirstInteraction, session);
  session.history.push({ role:'assistant', content: reply });
  // Extract total, order lines and modalidad from assistant reply
  const replyTotalMatch = reply.match(/TOTAL[^$]*\$([\d,]+\.\d{2})/i);
  if (replyTotalMatch) {
    session.lastQuoteTotal = replyTotalMatch[1].replace(/,/g,'');
    console.log(`[TOTAL CAPTURED] $${session.lastQuoteTotal}`);
  }
  // Extract order lines: "Nx Brand Size Position" patterns
  const replyLineMatches = [...reply.matchAll(/(\d+)x\s+([\w\s]+?)\s+(\d{2,3}[\d\/R.]+\w*)\s*(Steer|Traction|Trailer|All Position)?/gi)];
  if (replyLineMatches.length > 0) {
    session.confirmedOrderLines = replyLineMatches
      .map(m => `${m[1]}x ${m[2].trim()} ${m[3]}${m[4]?' '+m[4]:''}`.trim())
      .join(' | ');
    console.log(`[LINES CAPTURED] ${session.confirmedOrderLines}`);
  }
  // Capture modalidad from reply text
  if (/pickup|recoger|recogerlas/i.test(reply)) session.confirmedModalidad = 'pickup';
  else if (/delivery|entreg/i.test(reply))        session.confirmedModalidad = 'delivery';
  else if (/monte|montar|instalac/i.test(reply))  session.confirmedModalidad = 'monte';
  if (session.confirmedModalidad) console.log(`[MODALIDAD CAPTURED] ${session.confirmedModalidad}`);



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
