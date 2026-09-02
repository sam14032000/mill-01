# Product Specification: Cross-Border FBA Pre-Clearance & Regulatory Orchestrator (MVP)

---

## 1. Vision & Goals

### Vision
Enable mid-market Indian consumer brands and their Export Management Agencies (EMAs) to ship bulk palletized inventory (LCL/FCL) directly into international fulfillment networks (starting with Amazon US FBA) with the same operational ease and predictability as a domestic warehouse replenishment.

### Business Goals
1. **Unblock Forwarder Freight Sales:** Provide freight forwarder sales reps with an upfront pre-clearance hook to convert stalled, high-margin export quotes.
2. **Empower Multi-Brand Export Agencies:** Allow Export Management Agencies (EMAs) to configure custom forwarder/CHA provider networks and manage bulk SKU compliance across multiple client brand catalogs.
3. **Eliminate Destination Port Demurrage:** Verify SKU formulation, 10-digit HTS tariff mapping, and physical packaging labels prior to factory dispatch—eliminating customs holds and Amazon dock rejections.
4. **Streamline Brand Oversight:** Provide brand founders and operations leads with transparent, read-only visibility into SKU regulatory readiness without operational overhead.

---

## 2. Target Personas & Jobs to be Done (JTBD)

| Persona | Context | Job to be Done |
| :--- | :--- | :--- |
| **Brand Operations Lead** | Mid-market Indian D2C brand (₹15Cr–₹150Cr ARR, Beauty & Skincare) | *"When I prepare to send 2–5 pallets to Amazon US FBA, I want to verify that my formulations and packaging comply with US MoCRA/FDA rules before booking freight so that my capital is not stranded in port customs."* |
| **Export Management Agency (EMA) Lead** | Agency handling EXIM and market expansion for 5–20 consumer brands | *"When I onboard and manage multiple client brands for US export, I want to configure our contracted freight forwarders/CHAs and upload SKU dossiers on the brands' behalf so that I can scale client export operations through a single workspace."* |
| **Brand Executive (Client View)** | Founder / Head of Growth at an agency-managed brand | *"When our agency prepares our international launch, I want a real-time read-only compliance health dashboard so that I can track SKU clearance progress and launch timelines without managing raw regulatory filings."* |
| **Forwarder Commercial Rep** | Sales Manager at an Indian Freight Forwarder | *"When an export lead hesitates due to customs, labeling, or IoR uncertainty, I want to send an instant pre-clearance audit link so that I can de-risk their shipment and close the freight booking."* |
| **Customs Broker / Receiving 3PL** | Destination Port Clearance Partner | *"When the cargo arrives at the US port, I want pre-audited 10-digit HTS codes, valid continuous bond details, and prior-notice filings so entry clearance is immediate."* |

---

## 3. Success Metrics

* **Lead-to-Booking Conversion:** $\ge 30\%$ of dropped forwarder export leads convert into confirmed freight bookings upon receiving a completed pre-clearance audit.
* **Pre-Clearance Turnaround Time:** $\le 48$ hours from asset/dossier upload to certified export document pack generation.
* **Agency Portfolio Efficiency:** $\le 4$ hours spent by an EMA account manager to configure logistics providers and submit compliance dossiers per client brand.
* **Zero Regulatory Demurrage:** $0$ port customs detentions or Amazon dock rejections caused by paperwork, labeling, or formulation errors on pre-cleared pilot shipments.

---

## 4. User Stories & Scope Boundaries

### In Scope (MVP)
* **US-1 (Forwarder Lead Dispatch):** Forwarder sales rep generates a branded audit link tied to an open freight quote and tracks brand onboarding progress.
* **US-2 (SKU & Packaging Intake):** Brand or designated EMA uploads 1–2 hero SKUs (ingredients, Certificate of Analysis lab report, packaging artwork dielines/photos, domestic HSN).
* **US-3 (Agency Provider Integration & Catalog Management):** EMA account managers link preferred forwarders/CHAs, manage multi-brand client portfolios, and upload compliance dossiers on behalf of brand clients.
* **US-4 (Compliance Audit & Action Items):** System displays clear Pass/Warning/Fail flags across US MoCRA/FDA ingredient lists, 10-digit HTS tariff mapping, and Amazon inbound packaging requirements.
* **US-5 (Remediation & Approval):** Brand or EMA updates label artwork or acknowledges required overlay stickers; system verifies resolution.
* **US-6 (Read-Only Brand Compliance Tracking):** Brand executive accesses a dedicated read-only dashboard showing real-time SKU readiness health, blocking issues, and certified document statuses.
* **US-7 (Certified Master Export Pack):** System generates the finalized Commercial Bill of Entry pack, US FDA Prior Notice confirmation reference, and FBA carton/pallet specification manifest.

### Out of Scope (MVP)
* Automated domestic bank e-BRC / EDPMS reconciliation (handled by existing domestic finance tools).
* Direct in-app payments to freight forwarders or customs brokers.
* Balance-sheet cargo insurance underwriting.
* Non-US destination clearance (EU, UK, GCC deferred to v2).
* Multi-category mixed shipments (strictly constrained to Skincare/Personal Care for pilot).

---

## 5. Screen Breakdown & User Flow

```
[AGENCY / FORWARDER WORKSPACE]         [COMPLIANCE ENGINE]            [OUTPUT & REPORTING]
  Page 1: Multi-Brand & Provider Config -> Page 3: SKU Intake    --> Page 5: Master Export Pack
  Page 2: Forwarder Pipeline Tracker    -> Page 4: Audit & Remediation   Page 6: Brand Read-Only Dashboard
```

### Page 1: Agency Provider & Portfolio Hub (EMA View)
* **Purpose:** Allow EMAs to manage multiple client brand accounts and assign preferred forwarders and CHAs.
* **Key Components:**
  * Client Brand Switcher (select active brand workspace).
  * Logistics Provider Configuration: Assign contracted Forwarder and destination CHA per trade lane.
  * Multi-Brand Catalog Health Overview (Aggregated status across client SKUs: *Draft*, *In Audit*, *Remediation*, *Export Ready*).
  * `Submit Dossier on Brand's Behalf` workflow trigger.

### Page 2: Forwarder Pipeline Tracker (Commercial View)
* **Purpose:** Enable forwarder commercial teams to initiate pre-clearance audits for stalled leads and monitor shipment readiness.
* **Key Components:**
  * Active Quote Table (Brand/Agency Name, Contact, Est. Pallet Volume, Destination: *US FBA*).
  * `Generate Audit Invite` action button (generates a unique intake link for Brand or EMA).
  * Shipment Readiness Status badge: `Invite Sent` $\rightarrow$ `Audit In Progress` $\rightarrow$ `Action Required` $\rightarrow$ `Export Ready`.

### Page 3: SKU Intake & Target Setup (Brand / EMA View)
* **Purpose:** Collect product formulation, classification, and physical packaging assets for 1–2 hero SKUs.
* **Key Components:**
  * Destination Selector: Target Amazon FC location and pallet volume estimate.
  * SKU Upload Module:
    * Product Title & Domestic HSN (6/8-digit).
    * Ingredient Formulation Sheet / Certificate of Analysis (PDF upload).
    * Primary & Secondary Packaging Artwork / Dieline (PDF/Image upload).
    * Carton dimensions, unit weight, and inner pack count.

### Page 4: Pre-Clearance Audit & Remediation Hub (Brand / EMA View)
* **Purpose:** Deliver unambiguous regulatory feedback and clear remediation instructions.
* **Key Components:**
  * **Tariff Mapping Card:** Domestic HSN matched to verified 10-digit US HTS code with applicable duty rates.
  * **Formulation & MoCRA Check:** Verified INCI ingredient nomenclature and restricted substances validation (Green Pass / Red Warning).
  * **Packaging & Physical Label Audit:** Automated validation of mandatory markings (Metric/Imperial net quantity, domestic US agent address placeholder, required hazard warnings).
  * **Remediation Action Box:** Explicit instructions (e.g., *"Apply 2x1 inch over-label sticker with imperial net wt (fl oz) on secondary carton before palletizing"*).

### Page 5: Master Export Pack & Booking Handshake (Shared View)
* **Purpose:** Deliver finalized compliance documentation and notify forwarders to execute physical freight booking.
* **Key Components:**
  * *Compliance Certificate Seal* (Validates pre-clearance completion).
  * Downloadable Asset Pack:
    * Certified Commercial Invoice & Packing List.
    * US FDA Prior Notice Confirmation Reference.
    * Amazon FBA Pallet & Master Carton Spec Sheet.
  * `Confirm Ready for Freight Booking` trigger (alerts the forwarder sales rep to lock pallet space).

### Page 6: Read-Only Brand Compliance Health Dashboard (Brand Client View)
* **Purpose:** Give brand leadership transparent, real-time visibility into export readiness without allowing accidental document or configuration overrides.
* **Key Components:**
  * **SKU Compliance Status Cards:** Visual indicator (*Ready to Ship*, *Action Required by Agency*, *Under Review*) for each submitted product.
  * **Assigned Logistics Partners:** Read-only summary of configured Forwarder, CHA, and target Amazon FC destination.
  * **Remediation Tracker:** Summary of active packaging/labeling adjustments in progress.
  * **Export Pack Archive:** View and download verified compliance seals and final clearance certificates.

---

## 6. Scope Tradeoffs & Decisions

| Decision | Included | Excluded | Rationale |
| :--- | :--- | :--- | :--- |
| **Operating Model** | Direct Brand + EMA Delegate Models | Self-service multi-tier enterprise permissions | Accommodates both direct-to-brand forwarder leads and agency-managed brand portfolios without building complex enterprise role hierarchies. |
| **Category Constraint** | Skincare / Beauty Only | Apparel, Food, Electronics | Beauty carries high margin, high US diaspora demand, and structured MoCRA/INCI rule sets suitable for rapid deterministic audit. |
| **Geographic Scope** | India $\rightarrow$ US Amazon FBA | EU, UK, Middle East | US FBA is the primary volume driver for Indian mid-market exporters; avoids multi-jurisdiction rule fragmentation in MVP. |
| **Verification Method** | Digital Dieline + Photo Audit | Physical sample lab testing | Digital verification of labeling text/warnings unblocks 90% of non-tariff barriers without physical transit delays. |

---

## Changed in this update
- **Section 1 & 2 (REVISED & APPENDED):** Added Export Management Agencies (EMAs) and Brand Executive personas along with their respective JTBDs for provider configuration, catalog dossier uploads, and read-only compliance tracking.
- **Section 3 & 4 (REVISED & APPENDED):** Added agency portfolio efficiency success metric and user stories US-3 (Agency Provider Integration) and US-6 (Read-Only Brand Compliance Tracking).
- **Section 5 (REVISED & APPENDED):** Added Page 1 (Agency Provider & Portfolio Hub) and Page 6 (Read-Only Brand Compliance Health Dashboard) to the screen breakdown and user flow.
- **Section 6 (APPENDED):** Documented the scope decision supporting both direct brand onboarding and EMA delegate operating models.