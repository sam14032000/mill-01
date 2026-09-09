/* ===========================================================================
   Pallet prototype — hash router + in-memory/localStorage state + the
   deterministic pre-clearance audit engine. No backend. Every button below
   changes real state and re-renders; nothing is a dead link.
   =========================================================================== */

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through to fresh seed */ }
  return seedState();
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function resetDemo() { localStorage.removeItem(STORAGE_KEY); state = seedState(); saveState(); render(); }

function genId(prefix, dict) {
  let n = Object.keys(dict).length + 1;
  while (dict[prefix + n]) n++;
  return prefix + n;
}
function findBrandByName(name) { return state.brands.find(b => b.name === name); }
function brand(id) { return state.brands.find(b => b.id === id); }
function sku(id) { return state.skus[id]; }

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------- download helper ---------- */
function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ---------- status derivation ---------- */
function labelForSku(s) {
  if (!s) return "Stalled — No Invite Sent";
  if (s.freightConfirmed) return "Booking Confirmed";
  if (!s.auditRun) return s.stage === "invite_sent" ? "Invite Sent" : "Audit In Progress";
  if (s.status === "action_required") return "Action Required";
  if (s.status === "export_ready") return "Export Ready";
  return "Audit In Progress";
}
function badgeColorForLabel(label) {
  if (label === "Export Ready" || label === "Booking Confirmed") return "green";
  if (label === "Action Required") return "red";
  if (label === "Invite Sent" || label === "Audit In Progress") return "blue";
  return "grey";
}
function badge(label) { return `<span class="badge ${badgeColorForLabel(label)}">${label}</span>`; }

function catalogStage(s) {
  if (!s.auditRun) return s.stage === "invite_sent" && !hasIntakeData(s) ? "Draft" : "In Audit";
  if (s.status === "action_required") return "Remediation";
  return "Export Ready";
}
function hasIntakeData(s) { return !!(s.ingredients && s.claimsCopy && s.domesticHsn); }

/* ===========================================================================
   AUDIT ENGINE — deterministic rule pass over whatever the user entered.
   =========================================================================== */
function runAudit(s) {
  const flags = [];
  const hsnKey = (s.domesticHsn || "").trim();
  const htsInfo = HSN_TO_HTS[hsnKey];
  let htsResult = htsInfo ? { ...htsInfo } : null;

  if (!htsInfo) {
    flags.push({
      key: "hts", level: "red", title: "HSN not recognized",
      detail: `Domestic HSN "${s.domesticHsn || "(blank)"}" has no mapped US HTS-10 code in the reference table.`,
      remedy: "Confirm the 8-digit HSN and resubmit, or route to manual classification.",
      field: "domesticHsn"
    });
  }

  const claimText = (s.claimsCopy || "").toLowerCase();
  const claimHits = DRUG_CLAIM_LEXICON.filter(p => claimText.includes(p));
  if (claimHits.length) {
    flags.push({
      key: "claim", level: "red", title: "Prohibited therapeutic claim detected",
      detail: `Flagged phrase(s): "${claimHits.join('", "')}". This reclassifies the product from Cosmetic (Ch. 33) to OTC Drug (Ch. 30), requiring NDC + FDA Drug Facility registration.`,
      remedy: "Remove the flagged phrase(s) from packaging/listing copy and rescan, or proceed under the Drug pathway.",
      field: "claimsCopy"
    });
    if (htsResult) htsResult = { ...OTC_DRUG_RECLASS, reclassified: true, originalHts: htsResult.hts };
    else htsResult = { ...OTC_DRUG_RECLASS, reclassified: true };
  }

  const ingText = (s.ingredients || "").toLowerCase();
  const ingHits = RESTRICTED_INGREDIENTS.filter(i => ingText.includes(i));
  if (ingHits.length) {
    flags.push({
      key: "ingredient", level: "red", title: "Restricted ingredient flagged",
      detail: `Formulation references: "${ingHits.join('", "')}" — banned/restricted for US cosmetic import.`,
      remedy: "Reformulate or provide a documented exemption before resubmitting.",
      field: "ingredients"
    });
  }

  LABEL_CHECKLIST.forEach(item => {
    if (!s.packagingChecklist[item.key]) {
      flags.push({
        key: item.key, level: "amber", title: item.label,
        detail: "Not yet confirmed by brand/EMA.",
        remedy: "Verify physically, then mark resolved below.",
        field: "checklist"
      });
    }
  });

  s.flags = flags;
  s.htsResult = htsResult;
  s.auditRun = true;
  s.stage = "intake_submitted";
  const blocking = flags.some(f => f.level === "red");
  s.status = blocking ? "action_required" : (flags.some(f => f.level === "amber") ? "action_required" : "export_ready");
  saveState();
  return flags;
}

/* ===========================================================================
   ROUTER
   =========================================================================== */
function parseHash() {
  const h = location.hash.replace(/^#\//, "");
  const parts = h.split("/").filter(Boolean);
  return { route: parts[0] || "forwarder", param: parts[1] || null };
}

function navigate(hash) { location.hash = hash; }

function render() {
  const { route, param } = parseHash();
  document.querySelectorAll(".mainnav a").forEach(a => {
    a.classList.toggle("active", a.dataset.route === route);
  });
  const app = document.getElementById("app");
  switch (route) {
    case "forwarder": app.innerHTML = viewForwarder(); break;
    case "agency": app.innerHTML = viewAgency(param); break;
    case "intake": app.innerHTML = viewIntake(param); break;
    case "audit": app.innerHTML = viewAudit(param); break;
    case "pack": app.innerHTML = viewPack(param); break;
    case "dashboard": app.innerHTML = viewDashboard(param); break;
    default: app.innerHTML = viewForwarder();
  }
  renderLogBadge();
}
window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", () => {
  if (!location.hash) location.hash = "#/forwarder";
  render();
  wireLogDrawer();
});

/* ===========================================================================
   PAGE 2 — Forwarder Pipeline Tracker
   =========================================================================== */
function viewForwarder() {
  const rows = state.forwarderQuotes.map(q => {
    const s = q.skuId ? sku(q.skuId) : null;
    const label = labelForSku(s);
    let actionHtml;
    if (!q.skuId) {
      actionHtml = `<button class="primary small" onclick="generateInvite('${q.id}')">Generate Audit Invite</button>`;
    } else {
      actionHtml = `
        <button class="secondary small" onclick="copyInvite('${q.id}')">Copy Invite Link</button>
        <button class="secondary small" onclick="navigate('#/audit/${s.id}')">View Progress</button>`;
    }
    return `<tr>
      <td>${q.brandName}</td>
      <td>${q.contact}</td>
      <td>${q.estPallets}</td>
      <td>${q.destination}</td>
      <td>${badge(label)}</td>
      <td class="hstack">${actionHtml}</td>
    </tr>`;
  }).join("");

  return `
  <div class="page-head">
    <h1>Forwarder Pipeline Tracker</h1>
    <p>Stalled export quotes for your commercial team. Send a pre-clearance audit invite to unblock the booking.</p>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Brand / Agency</th><th>Contact</th><th>Est. Pallets</th><th>Destination</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div id="inviteBox"></div>
  `;
}

function generateInvite(quoteId) {
  const q = state.forwarderQuotes.find(q => q.id === quoteId);
  if (!q) return;
  let b = findBrandByName(q.brandName);
  if (!b) {
    b = { id: genId("b", state.brands.reduce((o, x) => (o[x.id] = 1, o), {})), name: q.brandName, agency: null, ordersPerDay: 0, category: "Skincare" };
    state.brands.push(b);
  }
  const newId = genId("s", state.skus);
  state.skus[newId] = {
    id: newId, brandId: b.id, title: "", domesticHsn: "",
    ingredients: "", claimsCopy: "",
    packagingChecklist: { netQtyImperial: false, usAgentAddress: false, cosmeticWarnings: false, ispm15Pallet: false, fnskuBarcode: false },
    cartonDims: "", status: "draft", auditRun: false, stage: "invite_sent", flags: [], freightConfirmed: false
  };
  q.skuId = newId;
  q.status = "Invite Sent";
  saveState();
  render();
  toast(`Invite generated for ${q.brandName}`);
  const link = `${location.origin}${location.pathname}#/intake/${newId}`;
  const box = document.getElementById("inviteBox");
  if (box) {
    box.innerHTML = `<div class="card">
      <h2>Invite link for ${q.brandName}</h2>
      <div class="linkbox">${link}</div>
      <div class="hstack mt">
        <button class="primary" onclick="navigate('#/intake/${newId}')">Open as Brand (fill intake)</button>
      </div>
    </div>`;
  }
}
function copyInvite(quoteId) {
  const q = state.forwarderQuotes.find(q => q.id === quoteId);
  if (!q || !q.skuId) return;
  const link = `${location.origin}${location.pathname}#/intake/${q.skuId}`;
  navigator.clipboard?.writeText(link).catch(() => {});
  toast("Invite link copied");
  const box = document.getElementById("inviteBox");
  if (box) box.innerHTML = `<div class="card"><h2>Invite link for ${q.brandName}</h2><div class="linkbox">${link}</div></div>`;
}

/* ===========================================================================
   PAGE 1 — Agency Provider & Portfolio Hub
   =========================================================================== */
function viewAgency(paramBrandId) {
  const agencyBrands = state.brands.filter(b => b.agency);
  const activeId = paramBrandId || agencyBrands[0]?.id || state.brands[0]?.id;
  const b = brand(activeId);
  const prov = state.providers[activeId] || { forwarder: "", cha: "", fc: "" };

  const switcher = state.brands.map(x =>
    `<option value="${x.id}" ${x.id === activeId ? "selected" : ""}>${x.name}${x.agency ? "" : " (direct)"}</option>`).join("");

  const catalogRows = state.brands.map(x => {
    const skus = Object.values(state.skus).filter(s => s.brandId === x.id);
    const counts = { Draft: 0, "In Audit": 0, Remediation: 0, "Export Ready": 0 };
    skus.forEach(s => counts[catalogStage(s)]++);
    return `<tr>
      <td>${x.name}</td><td>${x.agency || "—"}</td>
      <td>${counts.Draft}</td><td>${counts["In Audit"]}</td><td>${counts.Remediation}</td><td>${counts["Export Ready"]}</td>
    </tr>`;
  }).join("");

  return `
  <div class="page-head">
    <h1>Agency Provider & Portfolio Hub</h1>
    <p>Configure logistics providers per client brand and submit compliance dossiers on their behalf.</p>
  </div>

  <div class="card">
    <h2>Client brand workspace</h2>
    <label>Active brand
      <select onchange="navigate('#/agency/'+this.value)">${switcher}</select>
    </label>
    ${b ? `<p class="muted">${b.name} · ${b.category} · ~${b.ordersPerDay}/day domestic orders</p>` : ""}

    <fieldset>
      <legend>Logistics provider configuration</legend>
      <label>Contracted Freight Forwarder
        <input id="provForwarder" type="text" value="${prov.forwarder || ""}" placeholder="e.g. OceanLink Freight" />
      </label>
      <label>Destination Customs House Agent (CHA)
        <input id="provCha" type="text" value="${prov.cha || ""}" placeholder="e.g. Nhava Sheva Customs Partners" />
      </label>
      <label>Target Amazon FC
        <input id="provFc" type="text" value="${prov.fc || ""}" placeholder="e.g. Amazon FBA — ONT8, California" />
      </label>
      <button class="primary" onclick="saveProviders('${activeId}')">Save provider config</button>
    </fieldset>

    <button class="secondary" onclick="navigate('#/intake/new/${activeId}')">Submit Dossier on Brand's Behalf</button>
  </div>

  <div class="card">
    <h2>Multi-brand catalog health</h2>
    <table>
      <thead><tr><th>Brand</th><th>Agency</th><th>Draft</th><th>In Audit</th><th>Remediation</th><th>Export Ready</th></tr></thead>
      <tbody>${catalogRows}</tbody>
    </table>
  </div>
  `;
}
function saveProviders(brandId) {
  state.providers[brandId] = {
    forwarder: document.getElementById("provForwarder").value.trim(),
    cha: document.getElementById("provCha").value.trim(),
    fc: document.getElementById("provFc").value.trim()
  };
  saveState();
  toast("Provider configuration saved");
  render();
}

/* ===========================================================================
   PAGE 3 — SKU Intake & Target Setup
   =========================================================================== */
function viewIntake(param) {
  let s, presetBrandId = null;
  const parts = location.hash.replace(/^#\//, "").split("/").filter(Boolean);
  // supports #/intake/<skuId> or #/intake/new/<brandId>
  if (parts[1] === "new") {
    presetBrandId = parts[2] || state.brands[0].id;
    s = null;
  } else if (parts[1]) {
    s = sku(parts[1]);
  } else {
    s = sku(state.activeSkuId);
  }

  const brandOptions = state.brands.map(b => `<option value="${b.id}" ${s ? (s.brandId === b.id ? "selected" : "") : (presetBrandId === b.id ? "selected" : "")}>${b.name}</option>`).join("");
  const hsnOptions = Object.keys(HSN_TO_HTS).map(k => `<option value="${k}" ${s && s.domesticHsn === k ? "selected" : ""}>${k} — ${HSN_TO_HTS[k].desc}</option>`).join("");

  const pk = s ? s.packagingChecklist : { netQtyImperial: false, usAgentAddress: false, cosmeticWarnings: false, ispm15Pallet: false, fnskuBarcode: false };
  const checklistHtml = LABEL_CHECKLIST.map(item => `
    <div class="checkrow">
      <input type="checkbox" id="chk_${item.key}" ${pk[item.key] ? "checked" : ""} />
      <label for="chk_${item.key}" style="margin:0">${item.label}</label>
    </div>`).join("");

  return `
  <div class="page-head">
    <h1>SKU Intake & Target Setup</h1>
    <p>Upload the hero SKU's formulation, claims copy, and packaging details for pre-clearance.</p>
  </div>

  <form class="card" id="intakeForm" onsubmit="return submitIntake(event, '${s ? s.id : ""}')">
    <div class="grid2">
      <label>Brand
        <select id="in_brand">${brandOptions}</select>
      </label>
      <label>Target Amazon FC / destination
        <input id="in_dest" type="text" value="${s && state.providers[s.brandId] ? (state.providers[s.brandId].fc || "") : ""}" placeholder="Amazon FBA — ONT8, California" />
      </label>
    </div>

    <label>Product title
      <input id="in_title" type="text" required value="${s ? s.title : ""}" placeholder="e.g. Turmeric Glow Face Cream" />
    </label>

    <div class="grid2">
      <label>Domestic HSN (8-digit)
        <select id="in_hsn">
          <option value="">Select…</option>
          ${hsnOptions}
        </select>
      </label>
      <label>Estimated pallet volume
        <input id="in_pallets" type="number" min="1" value="${s ? (s.pallets || 2) : 2}" />
      </label>
    </div>

    <label>Ingredient formulation (INCI names, comma or line separated)
      <textarea id="in_ingredients" rows="3" placeholder="Aqua, Glycerin, Niacinamide, ...">${s ? s.ingredients : ""}</textarea>
    </label>

    <label>Packaging / marketing claim copy (exact wording as printed / listed)
      <textarea id="in_claims" rows="3" placeholder="e.g. Brightens skin tone. Treats acne...">${s ? s.claimsCopy : ""}</textarea>
    </label>

    <label>Carton dimensions, unit weight, inner pack count
      <input id="in_carton" type="text" value="${s ? s.cartonDims : ""}" placeholder="30x20x15 cm, 0.9kg/unit, 24 units/carton" />
    </label>

    <fieldset>
      <legend>Physical packaging / label checklist</legend>
      ${checklistHtml}
    </fieldset>

    <button type="submit" class="primary">Save Dossier & Continue to Audit</button>
  </form>
  `;
}

function submitIntake(ev, existingId) {
  ev.preventDefault();
  const brandId = document.getElementById("in_brand").value;
  const id = existingId || genId("s", state.skus);
  const checklist = {};
  LABEL_CHECKLIST.forEach(item => { checklist[item.key] = document.getElementById(`chk_${item.key}`).checked; });

  state.skus[id] = {
    ...(state.skus[id] || {}),
    id, brandId,
    title: document.getElementById("in_title").value.trim(),
    domesticHsn: document.getElementById("in_hsn").value,
    ingredients: document.getElementById("in_ingredients").value.trim(),
    claimsCopy: document.getElementById("in_claims").value.trim(),
    cartonDims: document.getElementById("in_carton").value.trim(),
    pallets: parseInt(document.getElementById("in_pallets").value || "2", 10),
    packagingChecklist: checklist,
    status: "draft",
    auditRun: false,
    stage: "intake_submitted",
    flags: state.skus[id]?.flags || [],
    freightConfirmed: state.skus[id]?.freightConfirmed || false
  };
  state.activeSkuId = id;
  state.activeBrandId = brandId;
  if (!state.providers[brandId]) state.providers[brandId] = { forwarder: "", cha: "", fc: document.getElementById("in_dest").value.trim() };
  else state.providers[brandId].fc = document.getElementById("in_dest").value.trim() || state.providers[brandId].fc;

  // link back into forwarder pipeline if this brand has a stalled quote without a sku
  const q = state.forwarderQuotes.find(q => q.brandName === brand(brandId)?.name);
  if (q && !q.skuId) q.skuId = id;

  saveState();
  toast("Dossier saved");
  navigate(`#/audit/${id}`);
  return false;
}

/* ===========================================================================
   PAGE 4 — Pre-Clearance Audit & Remediation Hub
   =========================================================================== */
function viewAudit(skuId) {
  const s = sku(skuId || state.activeSkuId);
  if (!s) return `<div class="card">No SKU selected. <a href="#/intake">Create one in SKU Intake →</a></div>`;
  const b = brand(s.brandId);
  const label = labelForSku(s);

  if (!s.auditRun) {
    return `
    <div class="page-head">
      <h1>Pre-Clearance Audit & Remediation</h1>
      <p>${b ? b.name : ""} · ${s.title || "(untitled SKU)"} ${badge(label)}</p>
    </div>
    <div class="card">
      <h2>Dossier ready for audit</h2>
      <p class="muted">Domestic HSN: ${s.domesticHsn || "—"}<br/>Ingredients: ${s.ingredients || "—"}<br/>Claims copy: "${s.claimsCopy || "—"}"</p>
      <button class="primary" onclick="doRunAudit('${s.id}')">Run Pre-Clearance Audit</button>
      <button class="secondary" onclick="navigate('#/intake/${s.id}')">Edit dossier</button>
    </div>`;
  }

  const flags = s.flags || [];
  const redFlags = flags.filter(f => f.level === "red");
  const amberFlags = flags.filter(f => f.level === "amber");
  const okCount = (1 + 1 + 1 + LABEL_CHECKLIST.length) - flags.length;

  const htsCardBody = s.htsResult ? `
    <p><b>${s.htsResult.hts}</b> — ${s.htsResult.desc}</p>
    <p class="muted">Duty: ${s.htsResult.duty} · PGA: ${s.htsResult.pga}</p>
    ${s.htsResult.reclassified ? `<p class="muted">Original mapping before claim reclassification: ${s.htsResult.originalHts || "n/a"}</p>` : ""}
  ` : `<p class="muted">No HTS mapping resolved.</p>`;

  const claimFlag = flags.find(f => f.key === "claim");
  const ingredientFlag = flags.find(f => f.key === "ingredient");
  const hsnFlag = flags.find(f => f.key === "hts");

  const labelRows = LABEL_CHECKLIST.map(item => {
    const checked = s.packagingChecklist[item.key];
    return `<div class="flag ${checked ? "ok" : "warn"}">
      <h4>${item.label}</h4>
      <p>${checked ? "Confirmed." : "Not yet confirmed."}</p>
      ${!checked ? `<button class="secondary small" onclick="markResolved('${s.id}','${item.key}')">Mark Verified</button>` : ""}
    </div>`;
  }).join("");

  const canProceed = s.status === "export_ready";

  return `
  <div class="page-head">
    <h1>Pre-Clearance Audit & Remediation</h1>
    <p>${b ? b.name : ""} · ${s.title || "(untitled SKU)"} ${badge(label)}</p>
  </div>

  <div class="statcards">
    <div class="statcard"><div class="num">${redFlags.length}</div><div class="label">Blocking issues</div></div>
    <div class="statcard"><div class="num">${amberFlags.length}</div><div class="label">Label checks pending</div></div>
    <div class="statcard"><div class="num">${okCount}/${okCount + flags.length}</div><div class="label">Checks passed automatically</div></div>
    <div class="statcard"><div class="num">100%</div><div class="label">Checks run without a human (rule engine)</div></div>
  </div>

  <div class="grid2">
    <div class="card">
      <h2>Tariff & PGA Mapping</h2>
      ${htsCardBody}
      ${hsnFlag ? `
        <div class="flag">
          <h4>${hsnFlag.title}</h4><p>${hsnFlag.detail}</p>
          <div class="hstack">
            <select id="fixHsn">
              <option value="">Select correct HSN…</option>
              ${Object.keys(HSN_TO_HTS).map(k => `<option value="${k}">${k} — ${HSN_TO_HTS[k].desc}</option>`).join("")}
            </select>
            <button class="secondary small" onclick="fixField('${s.id}','domesticHsn', document.getElementById('fixHsn').value)">Save & Rescan</button>
          </div>
        </div>` : `<div class="flag ok"><h4>HSN → HTS-10 resolved</h4><p>No manual classification needed.</p></div>`}
    </div>

    <div class="card">
      <h2>Formulation & MoCRA Check</h2>
      <p class="muted">${s.ingredients || "—"}</p>
      ${ingredientFlag ? `
        <div class="flag">
          <h4>${ingredientFlag.title}</h4><p>${ingredientFlag.detail}</p>
          <textarea id="fixIngredients" rows="3">${s.ingredients}</textarea>
          <button class="secondary small mt" onclick="fixField('${s.id}','ingredients', document.getElementById('fixIngredients').value)">Save & Rescan</button>
        </div>` : `<div class="flag ok"><h4>No restricted ingredients found</h4><p>Formulation clears the current restricted-substances lexicon.</p></div>`}
    </div>
  </div>

  <div class="card">
    <h2>Claim & OTC Drug Risk Scanner</h2>
    <p class="muted">"${s.claimsCopy || "—"}"</p>
    ${claimFlag ? `
      <div class="flag">
        <h4>${claimFlag.title}</h4><p>${claimFlag.detail}</p>
        <textarea id="fixClaims" rows="3">${s.claimsCopy}</textarea>
        <button class="secondary small mt" onclick="fixField('${s.id}','claimsCopy', document.getElementById('fixClaims').value)">Save & Rescan</button>
      </div>` : `<div class="flag ok"><h4>No prohibited therapeutic claims detected</h4><p>Copy stays within Chapter 33 Cosmetic scope.</p></div>`}
  </div>

  <div class="card">
    <h2>Packaging & Physical Label Audit</h2>
    ${labelRows}
  </div>

  <div class="card">
    <h2>Overall status: ${badge(label)}</h2>
    <p class="muted">${canProceed ? "All checks clear. This SKU is ready for the master export pack." : "Resolve the blocking / pending items above, then rescan."}</p>
    <div class="hstack">
      <button class="secondary" onclick="doRunAudit('${s.id}')">Re-run Full Audit</button>
      <button class="primary" ${canProceed ? "" : "disabled"} onclick="navigate('#/pack/${s.id}')">Proceed to Export Pack</button>
    </div>
  </div>
  `;
}

function doRunAudit(skuId) {
  const s = sku(skuId);
  runAudit(s);
  render();
  const label = labelForSku(s);
  toast(label === "Export Ready" ? "Audit complete — Export Ready" : "Audit complete — action required");
}
function markResolved(skuId, key) {
  const s = sku(skuId);
  s.packagingChecklist[key] = true;
  runAudit(s);
  render();
  toast("Marked verified — rescanned");
}
function fixField(skuId, field, value) {
  const s = sku(skuId);
  s[field] = value;
  runAudit(s);
  render();
  toast("Updated — rescanned");
}

/* ===========================================================================
   PAGE 5 — Master Export Pack & Booking Handshake
   =========================================================================== */
function viewPack(skuId) {
  const s = sku(skuId || state.activeSkuId);
  if (!s) return `<div class="card">No SKU selected. <a href="#/audit">Go to Audit →</a></div>`;
  const b = brand(s.brandId);
  const prov = state.providers[s.brandId] || {};
  const ready = s.status === "export_ready";

  return `
  <div class="page-head">
    <h1>Master Export Pack & Booking Handshake</h1>
    <p>${b ? b.name : ""} · ${s.title || "(untitled SKU)"}</p>
  </div>

  ${ready ? `
    <div class="seal">
      <div class="icon">✔</div>
      <div><h2>Compliance Certificate Sealed</h2><p>Pre-clearance completed for ${s.title}. HTS ${s.htsResult?.hts || "—"} · PGA: ${s.htsResult?.pga || "—"}</p></div>
    </div>` : `
    <div class="flag"><h4>Not yet cleared</h4><p>Return to <a href="#/audit/${s.id}">Audit & Remediation</a> and resolve open flags before generating the export pack.</p></div>
  `}

  <div class="card">
    <h2>Downloadable asset pack</h2>
    <div class="filelist">
      <div class="filerow"><span>Certified Commercial Shipping Bill & Packing List</span>
        <button class="secondary small" ${ready ? "" : "disabled"} onclick="downloadShippingBill('${s.id}')">Download</button></div>
      <div class="filerow"><span>US MoCRA Product Listing (PPLA) & Facility FEI Reference Sheet</span>
        <button class="secondary small" ${ready ? "" : "disabled"} onclick="downloadMocra('${s.id}')">Download</button></div>
      <div class="filerow"><span>Amazon FBA Pallet (ISPM-15 GMA Grade A) & Master Carton Spec Sheet</span>
        <button class="secondary small" ${ready ? "" : "disabled"} onclick="downloadFbaSpec('${s.id}')">Download</button></div>
    </div>
  </div>

  <div class="card">
    <h2>Booking handshake</h2>
    <p class="muted">Forwarder: ${prov.forwarder || "—"} · CHA: ${prov.cha || "—"} · FC: ${prov.fc || "—"}</p>
    <button class="primary" ${ready && !s.freightConfirmed ? "" : "disabled"} onclick="confirmFreight('${s.id}')">
      ${s.freightConfirmed ? "Freight Booking Confirmed" : "Confirm Ready for Freight Booking"}
    </button>
    ${s.freightConfirmed ? `<p class="muted mt">Forwarder commercial rep notified — pallet space locked.</p>` : ""}
  </div>
  `;
}

function packHeader(s, b) {
  return `SKU: ${s.title}\nBrand: ${b ? b.name : ""}\nDomestic HSN: ${s.domesticHsn}\nUS HTS-10: ${s.htsResult?.hts || ""}\nPGA: ${s.htsResult?.pga || ""}\nGenerated: ${new Date().toISOString()}\n\n`;
}
function downloadShippingBill(skuId) {
  const s = sku(skuId), b = brand(s.brandId);
  downloadText(`${s.title || "sku"}-shipping-bill.txt`,
    packHeader(s, b) + `COMMERCIAL SHIPPING BILL & PACKING LIST\nCarton spec: ${s.cartonDims}\nPallets: ${s.pallets || "-"}\nIngredients: ${s.ingredients}\n`);
}
function downloadMocra(skuId) {
  const s = sku(skuId), b = brand(s.brandId);
  downloadText(`${s.title || "sku"}-mocra-listing.txt`,
    packHeader(s, b) + `US MoCRA PRODUCT LISTING (PPLA) & FACILITY FEI REFERENCE\nClaims copy reviewed: "${s.claimsCopy}"\nCleared: no prohibited therapeutic claims detected.\n`);
}
function downloadFbaSpec(skuId) {
  const s = sku(skuId), b = brand(s.brandId);
  const prov = state.providers[s.brandId] || {};
  downloadText(`${s.title || "sku"}-fba-carton-spec.txt`,
    packHeader(s, b) + `AMAZON FBA PALLET & MASTER CARTON SPEC\nCarton: ${s.cartonDims}\nTarget FC: ${prov.fc || "-"}\nPallet type: ISPM-15 heat-treated GMA Grade A, 4-way\n`);
}
function confirmFreight(skuId) {
  const s = sku(skuId);
  s.freightConfirmed = true;
  const q = state.forwarderQuotes.find(q => q.skuId === skuId);
  if (q) q.status = "Export Ready";
  saveState();
  render();
  toast("Forwarder notified — pallet space locked");
}

/* ===========================================================================
   PAGE 6 — Read-Only Brand Compliance Health Dashboard
   =========================================================================== */
function viewDashboard(brandId) {
  const activeId = brandId || state.activeBrandId || state.brands[0].id;
  const b = brand(activeId);
  const switcher = state.brands.map(x => `<option value="${x.id}" ${x.id === activeId ? "selected" : ""}>${x.name}</option>`).join("");
  const skus = Object.values(state.skus).filter(s => s.brandId === activeId);
  const prov = state.providers[activeId] || {};

  const cards = skus.map(s => {
    const label = labelForSku(s);
    const openFlags = (s.flags || []).length;
    return `<div class="card">
      <h2>${s.title || "(untitled SKU)"} ${badge(label)}</h2>
      <p class="muted">HSN ${s.domesticHsn || "—"} ${s.htsResult ? `→ HTS ${s.htsResult.hts}` : ""}</p>
      <p class="muted">${openFlags ? `${openFlags} open remediation item(s)` : "No open remediation items"}</p>
      ${s.freightConfirmed ? `
        <div class="hstack">
          <button class="secondary small" onclick="downloadShippingBill('${s.id}')">Shipping Bill</button>
          <button class="secondary small" onclick="downloadMocra('${s.id}')">MoCRA Listing</button>
          <button class="secondary small" onclick="downloadFbaSpec('${s.id}')">FBA Spec</button>
        </div>` : `<p class="muted">Export pack unlocks once freight booking is confirmed.</p>`}
    </div>`;
  }).join("") || `<div class="card muted">No SKUs submitted yet for this brand.</div>`;

  return `
  <div class="page-head">
    <h1>Brand Compliance Health Dashboard</h1>
    <p>Read-only view for brand leadership — no filing or configuration controls here.</p>
  </div>
  <div class="card">
    <label>Brand
      <select onchange="navigate('#/dashboard/'+this.value)">${switcher}</select>
    </label>
    <p class="muted">Assigned logistics partners — Forwarder: ${prov.forwarder || "—"} · CHA: ${prov.cha || "—"} · Target FC: ${prov.fc || "—"}</p>
  </div>
  ${cards}
  `;
}

/* ===========================================================================
   SESSION LOG DRAWER (assumption-testing instrument)
   =========================================================================== */
function wireLogDrawer() {
  const drawer = document.getElementById("logDrawer");
  const scrim = document.getElementById("scrim");
  document.getElementById("openLog").onclick = () => { drawer.classList.add("open"); scrim.classList.add("open"); renderLogTable(); };
  document.getElementById("closeLog").onclick = () => { drawer.classList.remove("open"); scrim.classList.remove("open"); };
  scrim.onclick = () => { drawer.classList.remove("open"); scrim.classList.remove("open"); };
  document.getElementById("screenerForm").onsubmit = (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const entry = Object.fromEntries(fd.entries());
    entry.ts = new Date().toISOString();
    state.log.push(entry);
    saveState();
    ev.target.reset();
    renderLogTable();
    renderLogBadge();
    toast("Session logged");
  };
  renderLogTable();
}
function renderLogBadge() {
  const el = document.getElementById("logCount");
  if (el) el.textContent = state.log.length;
}
function renderLogTable() {
  const body = document.getElementById("logTableBody");
  const empty = document.getElementById("logEmptyNote");
  if (!body) return;
  if (!state.log.length) { body.innerHTML = ""; empty.style.display = "block"; return; }
  empty.style.display = "none";
  body.innerHTML = state.log.slice().reverse().map((e, i) => `
    <tr>
      <td>${e.companyName}</td>
      <td>${e.ordersPerMonth}</td>
      <td>${e.whoHandles}</td>
      <td>${e.monthlySpend}</td>
      <td>${e.paidPilot}</td>
      <td><button class="ghost" onclick="deleteLog(${state.log.length - 1 - i})">✕</button></td>
    </tr>`).join("");
}
function deleteLog(idx) {
  state.log.splice(idx, 1);
  saveState();
  renderLogTable();
  renderLogBadge();
}
