# Product Specification: Cross-Border FBA Pre-Clearance & Regulatory Orchestrator (MVP)

---

## 1. Vision & Goals

### Vision
Enable mid-market Indian consumer brands to ship bulk palletized inventory (LCL/FCL) directly into international fulfillment networks (starting with Amazon US FBA) with the same operational ease and predictability as a domestic warehouse replenishment.

### Business Goals
1. **Unblock Forwarder Freight Sales:** Provide freight forwarder sales reps with an upfront pre-clearance hook to convert stalled, high-margin export quotes.
2. **Eliminate Destination Port Demurrage:** Verify SKU formulation, 10-digit HTS tariff mapping, and physical packaging labels prior to factory dispatch—eliminating customs holds and Amazon dock rejections.
3. **Streamline Warehouse Execution:** Generate a certified, single-source documentation and labeling pack that requires zero manual document manipulation at the brand's packing bench.

---

## 2. Target Personas & Jobs to be Done (JTBD)

| Persona | Context | Job to be Done |
| :--- | :--- | :--- |
| **Brand Operations Lead** | Mid-market Indian D2C brand (₹15Cr–₹150Cr ARR, Beauty & Skincare) | *"When I prepare to send 2–5 pallets to Amazon US FBA, I want to verify that my formulations and packaging comply with US MoCRA/FDA rules before booking freight so that my capital is not stranded in port customs."* |
| **Forwarder Commercial Rep** | Sales Manager at an Indian Freight Forwarder | *"When an export lead hesitates due to customs, labeling, or IoR uncertainty, I want to send an instant pre-clearance audit link so that I can de-risk their shipment and close the freight booking."* |
| **Customs Broker / Receiving 3PL** | Destination Port Clearance Partner | *"When the cargo arrives at the US port, I want pre-audited 10-digit HTS codes, valid continuous bond details, and prior-notice filings so entry clearance is immediate."* |

---

## 3. Success Metrics

* **Lead-to-Booking Conversion:** $\ge 30\%$ of dropped forwarder export leads convert into confirmed freight bookings upon receiving a completed pre-clearance audit.
* **Pre-Clearance Turnaround Time:** $\le 48$ hours from brand asset upload to certified export document pack generation.
* **Zero Regulatory Demurrage:** $0$ port customs detentions or Amazon dock rejections caused by paperwork, labeling, or formulation errors on pre-cleared pilot shipments.

---

## 4. User Stories & Scope Boundaries

### In Scope (MVP)
* **US-1 (Forwarder Lead Dispatch):** Forwarder sales rep generates a branded audit link tied to an open freight quote and tracks brand onboarding progress.
* **US-2 (SKU & Packaging Intake):** Brand uploads 1–2 hero SKUs (ingredients, Certificate of Analysis lab report, packaging artwork dielines/photos, domestic HSN).
* **US-3 (Compliance Audit & Action Items):** System displays clear Pass/Warning/Fail flags across US MoCRA/FDA ingredient lists, 10-digit HTS tariff mapping, and Amazon inbound packaging requirements.
* **US-4 (Remediation & Approval):** Brand updates label artwork or acknowledges required overlay stickers; system verifies resolution.
* **US-5 (Certified Master Export Pack):** System generates the finalized Commercial Bill of Entry pack, US FDA Prior Notice confirmation reference, and FBA carton/pallet specification manifest.

### Out of Scope (MVP)
* Automated domestic bank e-BRC / EDPMS reconciliation (handled by existing domestic finance tools).
* Balance-sheet cargo insurance underwriting.
* Non-US destination clearance (EU, UK, GCC deferred to v2).
* Multi-category mixed shipments (strictly constrained to Skincare/Personal Care for pilot).

---

## 5. Screen Breakdown & User Flow

```
[FORWARDER PORTAL]              [BRAND ONBOARDING & AUDIT]             [OUTPUT PACK]
  Page 1: Pipeline Tracker  -->   Page 2: SKU & Asset Intake    -->    Page 4: Master Export Pack
  (Dispatch Audit Link)           Page 3: Audit & Remediation          (Certified Files & Labels)
```

### Page 1: Forwarder Pipeline Tracker (Commercial View)
* **Purpose:** Enable forwarder commercial teams to initiate pre-clearance audits for stalled leads and monitor shipment readiness.
* **Key Components:**
  * Active Quote Table (Brand Name, Contact, Est. Pallet Volume, Destination: *US FBA*).
  * `Generate Audit Invite` action button (generates a unique brand intake link).
  * Shipment Readiness Status badge: `Invite Sent` $\rightarrow$ `Audit In Progress` $\rightarrow$ `Action Required` $\rightarrow$ `Export Ready`.

### Page 2: Brand SKU Intake & Target Setup (Brand View)
* **Purpose:** Collect product formulation, classification, and physical packaging assets for 1–2 hero SKUs.
* **Key Components:**
  * Shipment Destination Selector: Target Amazon FC location and pallet volume estimate.
  * SKU Upload Module:
    * Product Title & Domestic HSN (6/8-digit).
    * Ingredient Formulation Sheet / Certificate of Analysis (PDF upload).
    * Primary & Secondary Packaging Artwork / Dieline (PDF/Image upload).
    * Carton dimensions, unit weight, and inner pack count.

### Page 3: Pre-Clearance Audit & Remediation Hub (Brand View)
* **Purpose:** Deliver unambiguous regulatory feedback and clear remediation instructions.
* **Key Components:**
  * **Tariff Mapping Card:** Domestic HSN matched to verified 10-digit US HTS code with applicable duty rates.
  * **Formulation & MoCRA Check:** Verified INCI ingredient nomenclature and restricted substances validation (Green Pass / Red Warning).
  * **Packaging & Physical Label Audit:** Automated validation of mandatory markings (Metric/Imperial net quantity, domestic US agent address placeholder, required hazard warnings).
  * **Remediation Action Box:** Explicit instructions (e.g., *"Apply 2x1 inch over-label sticker with imperial net wt (fl oz) on secondary carton before palletizing"*).

### Page 4: Master Export Pack & Booking Handshake (Shared View)
* **Purpose:** Deliver the finalized compliance pack to the brand warehouse and notify the forwarder to lock the physical freight booking.
* **Key Components:**
  * *Compliance Certificate Seal* (Validates pre-clearance completion).
  * Downloadable Asset Pack:
    * Certified Commercial Invoice & Packing List.
    * US FDA Prior Notice Confirmation Reference.
    * Amazon FBA Pallet & Master Carton Spec Sheet.
  * `Confirm Ready for Freight Booking` trigger (notifies the forwarder sales rep that physical goods are ready for pickup).

---

## 6. Scope Tradeoffs & Decisions

| Decision | Included | Excluded | Rationale |
| :--- | :--- | :--- | :--- |
| **Category Constraint** | Skincare / Beauty Only | Apparel, Food, Electronics | Beauty carries high margin, high US diaspora demand, and structured MoCRA/INCI rule sets suitable for rapid deterministic audit. |
| **Geographic Scope** | India $\rightarrow$ US Amazon FBA | EU, UK, Middle East | US FBA is the primary volume driver for Indian mid-market exporters; avoids multi-jurisdiction rule fragmentation in MVP. |
| **Verification Method** | Digital Dieline + Photo Audit | Physical sample lab testing | Digital verification of labeling text/warnings unblocks 90% of non-tariff barriers without physical transit delays. |