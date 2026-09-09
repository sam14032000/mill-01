# Pallet — FBA Pre-Clearance Orchestrator (throwaway prototype)

Static, no-build click-through. Open `index.html` directly in a browser (or `python3 -m http.server` from this folder). No server, no build step, no dependencies. State lives in `localStorage`; refreshing mid-demo is safe.

## What this is testing

The product spec (six screens: Forwarder Pipeline, Agency Hub, SKU Intake, Audit & Remediation, Export Pack, Brand Dashboard) is built out end-to-end with real button wiring — nothing is a static mockup. Every screen mutates shared state:

- **Generate Audit Invite** creates a real SKU record and an intake link you can open as the brand.
- **Run Pre-Clearance Audit** executes a deterministic rule pass (in `data.js` / `app.js`) over whatever HSN, ingredients, and claims copy the user actually typed — HSN→HTS-10 mapping, a prohibited drug-claim lexicon (SPF, "treats acne", etc.), a restricted-ingredient list, and a physical label checklist.
- Every flag on the Audit page has an inline fix (**Save & Rescan**, **Mark Verified**) that re-runs the engine live.
- **Confirm Ready for Freight Booking** unlocks the export pack downloads and flips the forwarder pipeline status.

There is **no e-BRC/EDPMS reconciliation module** and **no finance/CA-facing screen** — per the product spec, that's explicitly out of scope for this MVP. It only surfaces as one line item in the discovery screener (below), because that's the actual assumption under test this round, not something the product itself does.

## The assumption under test

*"At least 25% of Indian D2C brands shipping 300–2,000 cross-border orders/month currently pay >₹25,000/month to manual CA retainers or third-party customs agents for export docs / e-BRC reconciliation, rather than relying on free bundled tools from aggregators like Shiprocket X."*

Note this targets **order-volume D2C brands** (300–2,000 cross-border parcels/month), which is a different company profile than the product spec's ICP (500–5,000 *domestic* orders/day shipping 2–10 *pallets*). Screen for both in the interview — if your recruited sample skews toward one, say so in the readout.

## How to run a session

1. Open the app, let the person click through **Forwarder Pipeline → Generate Audit Invite → SKU Intake → Run Audit → fix a flag → Export Pack → Brand Dashboard**. Seeded demo data (Kavala Skin, Bhumi Botanicals) is pre-loaded so you don't need to type from scratch — or let them enter their own SKU to make it visceral.
2. Click **Session Log** (top right) and fill in the screener live:
   - Cross-border orders/month
   - Who handles export docs / e-BRC today (in-house / CA retainer / customs agent / free aggregator tools / nobody)
   - Monthly spend specifically on export docs + e-BRC reconciliation
   - Would they commit to a paid pilot today (₹25,000 setup + ₹15,000/run)
3. Repeat across calls — the table in the drawer accumulates every session (persisted locally, one browser only).

## Reading the result

- **Kill signal:** most respondents say ₹0 or <₹10k/month and point at Shiprocket X / free aggregator tools with no mention of a CA/customs-agent line item.
- **Confirm signal:** ≥25% of qualifying respondents (300–2,000 orders/month) name a CA retainer or customs agent specifically for export docs / e-BRC, at >₹25,000/month, independent of whatever aggregator they already use for shipping labels.
- Cross-reference the **paid pilot** answer against spend — someone paying >₹25k/month to a CA is the person most likely to say yes to a ₹25k one-time + ₹15k/run alternative. If spend is high but pilot commitment is low, that's a pricing/trust objection, not a demand objection — write that down separately.

## Known gaps (fine for a throwaway prototype)

- No real HTS/MoCRA database — `data.js` has ~5 illustrative HSN codes and ~10 lexicon phrases, enough to make the audit feel real, not enough to file an actual shipment.
- Single browser tab, single user, no multi-device sync.
- Downloads are plain `.txt` stand-ins for the shipping bill / MoCRA listing / FBA spec sheet, not real filings.
