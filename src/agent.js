    }
  }

  // ── Tire selection — runs unconditionally before quote generation ──────────
  const _availForSelection = session.current.tires.length > 0
    ? session.current.tires
    : (getLastSearch(session)?.tires || []);
  const selectedOption = findSelection(text, _availForSelection);
  if (selectedOption) {
    const posKey = getSelectionPositionKey(session);
    session.selectedTires[posKey] = selectedOption.tire;
    console.log(`[SELECTION] posKey=${posKey} tire=${selectedOption.tire.brand} idx=${selectedOption.idx} kind=${selectedOption.kind}`);
  }

  // ── Build quote ───────────────────────────────────────────────────────────
  let quoteContext = '';
  const wantsQuote = /cuanto|precio|total|costo|quote|how much|desglose|calcul|cotiz/i.test(text);

  const lastSearch = getLastSearch(session);
  const availableTires = session.current.tires.length > 0 ? session.current.tires : (lastSearch ? lastSearch.tires : []);

  // Generate combined quote whenever delivery mode is known and multiple searches exist
  const hasDeliveryChoice = !!(session.confirmedModalidad || session.modalidad);
  const isConfirmationMsg  = !!extractEmail(text); // message with customer data
  const wantsFullQuote = !isConfirmationMsg && (hasDeliveryChoice 
    || /cotiz|total|cuanto|precio|quote|how much|desglose|\bmonte\b|\bmontar\b|delivery|recoger|pickup|paso a|llevarme|envio|envío/i.test(text));
  console.log(`[QUOTE CHECK] wantsFullQuote=${wantsFullQuote} searches=${session.searches?.length} hasDelivery=${hasDeliveryChoice} isConfirm=${isConfirmationMsg} logged=${session.logged}`);
  if (wantsFullQuote && session.searches && session.searches.length > 1) {
    const combinedLines = ['*COTIZACION COMPLETA*'];
    let grandTotal = 0;
    const mount    = session.modalidad === 'monte';
    const valve    = /válvula|valvula|valve|stem/i.test(text);
    const disposal = /basura|disposal|dispos|llantas viejas/i.test(text);

    const seenKeys = new Set();
    let totalTires = 0, totalTax = 0, totalMount = 0;
    session.searches.forEach(s => {
      if (!s.tires || s.tires.length === 0) return;
      const dedupeKey = s.position || s.key || 'default';
      if (seenKeys.has(dedupeKey)) return;
      seenKeys.add(dedupeKey);
      const posKey = s.position || 'default';
      const tire   = session.selectedTires?.[posKey] || session.selectedTires?.['default'] || s.tires[0];
      console.log(`[COMBINED TIRE] pos=${posKey} selected=${session.selectedTires?.[posKey]?.brand} default=${session.selectedTires?.['default']?.brand} using=${tire.brand}`);
      const qty    = getRequestedQty(session, posKey);
      const c = calcTotal(tire, qty, mount, valve, disposal);
      const lineTotal = tire.price * qty;
      totalTires += lineTotal;
      totalTax   += c.tax;
      totalMount += c.mc;
      combinedLines.push(`🛞 *${qty}x ${tire.brand} ${tire.size}${s.position?' '+s.position:''}*\n   $${tire.price}/llanta × ${qty} = $${lineTotal.toFixed(2)}`);
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
    session.confirmedOrderLines = Array.from(seenKeys).map(posKey => {
      const s = session.searches.find(s => (s.position || 'default') === posKey);
      if (!s || !s.tires?.length) return null;
      const tire = session.selectedTires?.[posKey] || s.tires[0];
      const qty  = getRequestedQty(session, posKey);
      return `${qty}x ${tire.brand} ${tire.size}${s.position ? ' ' + s.position : ''}`;
    }).filter(Boolean).join(' | ');
    session.confirmedModalidad = session.modalidad || 'pendiente';
    console.log(`[COMBINED TOTAL] $${session.lastQuoteTotal} | lines=${session.confirmedOrderLines} | modalidad=${session.confirmedModalidad}`);
    const quoteText = combinedLines.join('\n');
    session.lastCombinedQuote = quoteText; // cache for re-injection
    quoteContext = '\n\n[QUOTE — presenta esta cotización al cliente y pregunta si confirma:\n' + quoteText + ']';

  } else if (availableTires.length > 0 && (generalQty || wantsQuote || selectedOption)) {
    const posKey = getSelectionPositionKey(session);
    const tire   = session.selectedTires?.[posKey] || selectedOption?.tire || availableTires[0];
    const qty    = getRequestedQty(session, posKey);
    const mount    = session.modalidad === 'monte';
    const valve    = /válvula|valvula|valve|stem/i.test(text);
    const disposal = /basura|disposal|dispos|llantas viejas|old tires/i.test(text);
    if (qty >= 1 && qty <= 24) {
      const quoteStr = formatQuote(tire, qty, mount);
      // Extract total from quote for later logging
      const totalMatch = quoteStr.match(/TOTAL: \$([\d.]+)/);
      if (totalMatch) session.lastQuoteTotal = totalMatch[1];
      quoteContext = `\n\n[QUOTE:\n${quoteStr}]`;
    }
  }

  // Re-inject cached quote if delivery known, no new quote generated, and order not yet confirmed
  if (!quoteContext && (session.confirmedModalidad || session.modalidad) && session.lastCombinedQuote && !session.logged && !session.promoAnswered && !isConfirmationMsg) {
    quoteContext = '\n\n[QUOTE:\n' + session.lastCombinedQuote + ']';
    console.log('[QUOTE REINJECTED]');
  }

  // ── Email offer ───────────────────────────────────────────────────────────
  let emailOffer = '';
  if (!session.emailOffered && !session.email && quoteContext) {
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

  // step management — no longer ask for name

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system:     SYSTEM_PROMPT,
    messages:   session.history,
  });

  const reply = response.content[0].text;
  session.history.push({ role:'assistant', content: reply });
  // Extract total, order lines and modalidad from Claude's reply
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
