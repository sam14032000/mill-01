# Product Specification: Cross-Border FBA Pre-Clearance & Regulatory Orchestrator (MVP)

---

## 1. Vision & Goals

### Vision
Enable mid-market Indian consumer brands and their Export Management Agencies (EMAs) to ship bulk palletized inventory (LCL/FCL) directly into international fulfillment networks (starting with Amazon US FBA) with the same operational ease and predictability as a domestic warehouse replenishment.

### Business Goals
1. **Unblock Forwarder Freight Sales:** Provide freight forwarder commercial sales reps with an upfront SKU pre-clearance mechanism to convert stalled, high-margin export quotes.
2. **Empower Multi-Brand Export Agencies:** Allow Export Management Agencies (EMAs) to configure custom logistics networks and manage bulk SKU compliance across multiple client brand catalogs.
3. **Eliminate Destination Port Demurrage & Rejection:** Verify SKU formulation, on-pack marketing claims, 10-digit HTS tariff classification, US MoCRA compliance, and physical packaging labels prior to factory dispatch—eliminating customs holds, FDA Import Alerts, and Amazon dock rejections.
4. **Streamline Brand Oversight:** Provide brand founders and operations leads with transparent, read-only visibility into SKU regulatory readiness without operational overhead.

---

## 2. Target Personas & Jobs to be Done (JTBD)

| Persona | Context | Job to be Done |
| :--- | :--- | :--- |
| **Brand Operations Lead** | Mid-market Indian D2C brand (₹15Cr–₹150Cr ARR, Beauty & Skincare) | *"When I prepare to send 2–5 pallets to Amazon US FBA, I want to verify that my formulations, marketing claims, and packaging comply with US MoCRA/FDA rules before booking freight so that my capital is not stranded in port customs."* |
| **Export Management Agency (EMA) Lead** | Agency handling EXIM and market expansion for 5–20 consumer brands | *"When I onboard and manage multiple client brands for US export, I want to configure our contracted freight forwarders/CHAs and upload SKU dossiers on the brands' behalf so that I can scale client export operations through a single workspace."* |
| **Brand Executive (Client View)** | Founder / Head of Growth at an agency-managed brand | *"When our agency prepares our international launch, I want a real-time read-only compliance health dashboard so that I can track SKU clearance progress and launch timelines without managing raw regulatory filings."* |
| **Forwarder Commercial Rep** | Sales Manager at an Indian Freight Forwarder | *"When an export lead hesitates due to customs, labeling, or Importer of Record (IoR) uncertainty, I want to send an instant pre-clearance audit link so that I can de-risk their shipment and close the freight booking."* |
| **Customs Broker / Receiving 3PL** | Destination Port Clearance Partner | *"When cargo arrives at the US port, I want pre-audited 10-digit HTS codes, valid Continuous Customs Bond references, US Domestic Agent records, and MoCRA ACE Partner Government Agency (PGA) message sets so entry clearance is immediate."* |

---

## 3. Success Metrics

* **Lead-to-Booking Conversion:** $\ge 40\%$ (at least 2 out of 5) of dropped forwarder export leads convert into confirmed freight bookings upon receiving a completed hero-SKU pre-clearance audit.
* **Pre-Clearance Turnaround Time:** $\le 48$ hours from asset/dossier upload to certified export document pack generation.
* **Rules Automation Rate:** $\ge 80\%$ of pre-clearance validation checks (INCI nomenclature, banned/restricted ingredient lists, 10-digit HTS mapping, and prohibited drug claim flags) executed deterministically by the system prior to audit sign-off.
* **Agency Portfolio Efficiency:** $\le 4$ hours spent by an EMA account manager to configure logistics providers and submit compliance dossiers per client brand.
* **Zero Regulatory Demurrage:** $0$ port customs detentions or Amazon dock rejections caused by documentation, labeling, or formulation errors on pre-cleared pilot shipments.

---

## 4. User Stories & Scope Boundaries

### In Scope (MVP)
* **US-1 (Forwarder Lead Dispatch):** Forwarder sales rep generates a branded pre-clearance audit link tied to an open freight quote and tracks brand onboarding progress.
* **US-2 (SKU & Packaging Intake):** Brand or designated EMA uploads 1–2 hero SKUs (ingredients list, Certificate of Analysis lab report, packaging artwork dielines/photos, domestic 8-digit HSN).
* **US-3 (Agency Provider Integration & Catalog Management):** EMA account managers link preferred forwarders/CHAs, manage multi-brand client portfolios, and upload compliance dossiers on behalf of brand clients.
* **US-4 (Formulation & Drug Claim Audit):** System audits ingredient lists against US MoCRA/FDA databases and scans on-pack label copy for prohibited therapeutic/drug claims (e.g., "treats acne", "SPF") that trigger reclassification from Cosmetic (Chapter 33) to OTC Drug (Chapter 30).
* **US-5 (Tariff Mapping & PGA Message Generation):** System resolves domestic 8-digit HSN to US 10-digit HTS codes (e.g., `3304.99.5000`) and generates required Partner Government Agency (PGA) ACE message set references (MoCRA Facility FEI and Product Listing PPLA).
* **US-6 (Remediation & Approval):** Brand or EMA updates label artwork or acknowledges required overlay stickers (imperial net weight, US Domestic Agent address); system verifies resolution.
* **US-7 (Read-Only Brand Compliance Tracking):** Brand executive accesses a dedicated read-only dashboard showing real-time SKU readiness health, blocking issues, and certified document statuses.
* **US-8 (Certified Master Export Pack):** System generates the finalized Commercial Shipping Bill manifest pack, MoCRA product listing references, and Amazon FBA pallet/carton specification sheets.

### Out of Scope (MVP)
* Automated domestic bank e-BRC / EDPMS reconciliation (handled by existing domestic finance/banking tools).
* Direct in-app payments to freight forwarders or customs brokers.
* Direct balance-sheet cargo insurance underwriting or absorbing sovereign physical customs inspection risk.
* Non-US destination clearance (EU, UK, GCC deferred to v2).
* Multi-category mixed shipments (strictly constrained to Skincare/Personal Care for pilot).
* Food/Dietary Supplement Bioterrorism Act Prior Notice filings (cosmetics/skincare do not require Prior Notice).

---

## 5. Screen Breakdown & User Flow

```
[AGENCY / FORWARDER WORKSPACE]         [COMPLIANCE ENGINE]            [OUTPUT & REPORTING]
  Page 1: Multi-Brand & Provider Hub   -> Page 3: SKU Intake    --> Page 5: Master Export Pack
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
    * Product Title & Domestic HSN (8-digit).
    * Ingredient Formulation Sheet / Certificate of Analysis (PDF upload).
    * Primary & Secondary Packaging Artwork / Dielines / Real-pack Photos (PDF/Image upload).
    * US Domestic Agent / Continuous Customs Bond status indicators.
    * Carton dimensions, unit weight, and inner pack count.

### Page 4: Pre-Clearance Audit & Remediation Hub (Brand / EMA View)
* **Purpose:** Deliver unambiguous regulatory feedback, claim violation flags, and clear remediation instructions.
* **Key Components:**
  * **Tariff & PGA Mapping Card:** Domestic HSN matched to verified 10-digit US HTS code (e.g., `3304.99.5000`) with duty rates and CBP ACE message flags.
  * **Formulation & MoCRA Check:** Verified INCI ingredient nomenclature, color additive check, and restricted substances validation.
  * **Claim & OTC Drug Risk Scanner:** Flags high-risk marketing claims (e.g., "cure", "acne treatment", "sun protection") on packaging copy that risk FDA reclassification to Chapter 30 OTC Drug.
  * **Packaging & Physical Label Audit:** Automated validation of mandatory markings (Metric + Imperial net quantity, designated US Agent address placeholder, required cosmetic warnings).
  * **Remediation Action Box:** Explicit instructions (e.g., *"Apply 2x1 inch over-label sticker with imperial net wt (fl oz) and US Domestic Agent address on secondary carton before palletizing"*).

### Page 5: Master Export Pack & Booking Handshake (Shared View)
* **Purpose:** Deliver finalized compliance documentation and notify forwarders to execute physical freight booking.
* **Key Components:**
  * *Compliance Certificate Seal* (Validates pre-clearance completion).
  * Downloadable Asset Pack:
    * Certified Commercial Shipping Bill & Packing List.
    * US MoCRA Product Listing (PPLA) and Facility FEI Reference Sheet.
    * Amazon FBA Pallet (ISPM-15 GMA Grade A) & Master Carton Spec Sheet.
  * `Confirm Ready for Freight Booking` trigger (alerts forwarder commercial rep to lock pallet space).

### Page 6: Read-Only Brand Compliance Health Dashboard (Brand Client View)
* **Purpose:** Give brand leadership transparent, real-time visibility into export readiness without allowing accidental document or configuration overrides.
* **Key Components:**
  * **SKU Compliance Status Cards:** Visual indicator (*Ready to Ship*, *Action Required by Agency*, *Under Review*) for each submitted product.
  * **Assigned Logistics Partners:** Read-only summary of configured Forwarder, CHA, and target Amazon FC destination.
  * **Remediation Tracker:** Summary of active packaging/labeling adjustments in progress.
  * **Export Pack Archive:** View and download verified compliance seals and clearance certificates.

---

## 6. Scope Tradeoffs & Decisions

| Decision | Included | Excluded | Rationale |
| :--- | :--- | :--- | :--- |
| **Operating Model** | Direct Brand + EMA Delegate Models | Self-service multi-tier enterprise permissions | Accommodates both direct-to-brand forwarder leads and agency-managed brand portfolios without building complex enterprise role hierarchies. |
| **Category Constraint** | Skincare / Beauty Only | Apparel, Food, Supplements, Electronics | Beauty carries high margin, high US diaspora demand, and structured MoCRA/INCI rule sets suitable for rapid deterministic audit. |
| **Regulatory Boundary** | Pre-Flight Statutory Defect Proofing (MoCRA, HTS-10, Claims, Labels) | Absolute Guarantee Against Sovereign Physical Inspection Holds | Eliminates documentation/classification failure modes; standard commercial SaaS SLA without balance-sheet exposure to discretionary CBP/FDA port holds. |
| **Export Documentation** | Commercial Shipping Bill (ICEGATE) Manifesting | Domestic Banking e-BRC / EDPMS Reconciliation | Resolves the destination blocker while avoiding overlap with domestic banking and accounting tools. |
| **Verification Method** | Digital Dieline + Photo Audit + OCR Claim Check | Physical sample laboratory testing | Digital verification of formulation and labeling unblocks non-tariff barriers without physical transit delays. |

---

## Changed in this update
- **Section 1, 2 & 4 (REVISED):** Corrected Indian export documentation terminology from "Commercial Bill of Entry" to "Commercial Shipping Bill"; updated destination filing references from FDA Prior Notice (applicable to food/supplements) to US MoCRA Product Listing (PPLA), Facility FEI registration, and ACE PGA message sets.
- **Section 3 (APPENDED):** Added the Rules Automation Rate metric ($\ge 80\%$ deterministic validation checks) and aligned lead conversion threshold to $\ge 40\%$.
- **Section 4 & 5 (REVISED & APPENDED):** Added on-pack marketing/therapeutic claim scanning (US-4) to detect Cosmetic-to-OTC-Drug reclassification risks (Chapter 33 vs Chapter 30) and updated screen cards on Page 4 and Page 5.
- **Section 6 (APPENDED):** Added explicit scope tradeoff decisions on the Regulatory Boundary (pre-flight defect proofing vs sovereign discretionary holds) and Export Documentation scope.