/* ===========================================================================
   Reference data: HSN->HTS-10 map, drug-claim lexicon, restricted ingredients,
   mandatory label checklist. Small, deterministic, and intentionally literal
   to the KB tables — this is the "80% of checks run without a human" engine.
   =========================================================================== */

const HSN_TO_HTS = {
  "3304 99 10": {
    hts: "3304.99.5000",
    desc: "Other: Other: Other (Skin care lotions/creams)",
    duty: "Free (0%)",
    pga: "FDA — MoCRA Facility FEI & Product Listing (PPLA)",
    chapter: 33
  },
  "3304 10 00": {
    hts: "3304.10.0000",
    desc: "Lip make-up preparations (lipsticks, glosses)",
    duty: "Free (0%)",
    pga: "FDA — Color additive compliance required",
    chapter: 33
  },
  "3304 99 30": {
    hts: "3304.99.5000",
    desc: "Sunscreen / sunburn preventive (cosmetic form, no therapeutic claim)",
    duty: "Free (0%)",
    pga: "FDA — MoCRA Facility FEI & Product Listing (PPLA)",
    chapter: 33,
    watch: "If SPF / sunburn-prevention claims appear on pack, this reclassifies to 3004.90.9203 (OTC Drug) — see claim scanner."
  },
  "3305 90 40": {
    hts: "3305.90.0000",
    desc: "Preparations for use on the hair: Other",
    duty: "Free (0%)",
    pga: "FDA — Botanical review",
    chapter: 33
  },
  "3307 30 10": {
    hts: "3307.30.5000",
    desc: "Perfumed bath salts and other bath preparations: Other",
    duty: "4.9%",
    pga: "FDA — standard cosmetic review",
    chapter: 33
  }
};

const OTC_DRUG_RECLASS = {
  hts: "3004.90.9203",
  desc: "Reclassified out of Chapter 33 — Unapproved New OTC Drug pathway",
  duty: "Free (0%), but blocked pending NDC",
  pga: "FDA Drug Listing, National Drug Code (NDC), US Facility Drug Master File"
};

// Prohibited / risky therapeutic claim phrases — presence on pack copy forces
// Cosmetic -> OTC Drug reclassification under FDA rules.
const DRUG_CLAIM_LEXICON = [
  "cures acne", "cure acne", "treats acne", "acne treatment",
  "treats eczema", "treats psoriasis", "repairs melanin",
  "spf", "sun protection", "sunburn protection", "sunscreen",
  "antiseptic", "anti-inflammatory", "heals wounds", "reduces inflammation",
  "structure-function", "treats pigmentation", "clinically proven to cure",
  "kills bacteria", "anti-fungal", "antibacterial", "wound healing"
];

// Restricted / banned INCI ingredients for US cosmetic import (illustrative
// subset for the prototype — not a legal reference list).
const RESTRICTED_INGREDIENTS = [
  "hydroquinone", "mercury", "mercuric chloride", "chlorofluorocarbon propellants",
  "methylene chloride", "chloroform", "vinyl chloride", "bithionol",
  "steroids", "hexachlorophene"
];

// Mandatory physical/label checklist items required before palletizing.
const LABEL_CHECKLIST = [
  { key: "netQtyImperial", label: "Net quantity declared in metric AND imperial units (fl oz)" },
  { key: "usAgentAddress", label: "US Domestic Agent name + physical US street address printed on secondary carton" },
  { key: "cosmeticWarnings", label: "Required cosmetic warning statements present in English" },
  { key: "ispm15Pallet", label: "ISPM-15 heat-treated GMA Grade A 4-way pallet confirmed with supplier" },
  { key: "fnskuBarcode", label: "FNSKU barcode applied and scan-verified per unit" }
];

/* ===========================================================================
   Seed data — demo brands, hero SKUs, and forwarder pipeline. Everything here
   is mutable at runtime; app.js persists working state to localStorage under
   STORAGE_KEY so a session survives a page refresh mid-demo.
   =========================================================================== */

const STORAGE_KEY = "f05e_pallet_proto_v1";

function seedState() {
  return {
    brands: [
      { id: "b1", name: "Kavala Skin", agency: "Meridian Export Agency", ordersPerDay: 640, category: "Skincare" },
      { id: "b2", name: "Bhumi Botanicals", agency: "Meridian Export Agency", ordersPerDay: 1120, category: "Skincare" },
      { id: "b3", name: "Suvarna Naturals", agency: null, ordersPerDay: 480, category: "Skincare" }
    ],
    providers: {
      b1: { forwarder: "OceanLink Freight", cha: "Nhava Sheva Customs Partners", fc: "Amazon FBA — ONT8, California" },
      b2: { forwarder: "OceanLink Freight", cha: "Nhava Sheva Customs Partners", fc: "Amazon FBA — MDW2, Illinois" },
      b3: { forwarder: null, cha: null, fc: null }
    },
    skus: {
      s1: {
        id: "s1", brandId: "b1", title: "Turmeric Glow Face Cream",
        domesticHsn: "3304 99 10",
        ingredients: "Aqua, Curcuma Longa (Turmeric) Root Extract, Glycerin, Cetearyl Alcohol, Niacinamide, Tocopherol, Phenoxyethanol",
        claimsCopy: "Brightens skin tone. Treats acne and repairs melanin overnight. Suitable for daily use.",
        packagingChecklist: { netQtyImperial: false, usAgentAddress: false, cosmeticWarnings: true, ispm15Pallet: false, fnskuBarcode: true },
        cartonDims: "30x20x15 cm, 0.9kg/unit, 24 units/carton",
        status: "draft",
        auditRun: false,
        flags: [],
        remediationNotes: {}
      },
      s2: {
        id: "s2", brandId: "b2", title: "Neem Tulsi Hair Tonic",
        domesticHsn: "3305 90 40",
        ingredients: "Aqua, Azadirachta Indica (Neem) Oil, Ocimum Sanctum (Tulsi) Extract, Cetrimonium Chloride, Fragrance",
        claimsCopy: "Nourishes scalp and strengthens hair with traditional botanicals.",
        packagingChecklist: { netQtyImperial: true, usAgentAddress: true, cosmeticWarnings: true, ispm15Pallet: true, fnskuBarcode: true },
        cartonDims: "25x15x10 cm, 0.4kg/unit, 36 units/carton",
        status: "draft",
        auditRun: false,
        flags: [],
        remediationNotes: {}
      }
    },
    forwarderQuotes: [
      { id: "q1", brandName: "Kavala Skin", contact: "Rhea Malhotra, Ops Lead", estPallets: 3, destination: "US FBA — ONT8", status: "Invite Sent", skuId: "s1" },
      { id: "q2", brandName: "Bhumi Botanicals", contact: "Arjun Sethi, Founder", estPallets: 5, destination: "US FBA — MDW2", status: "Invite Sent", skuId: "s2" },
      { id: "q3", brandName: "Suvarna Naturals", contact: "Meera Iyer, Ops", estPallets: 2, destination: "US FBA — TBD", status: "Stalled — No Invite Sent", skuId: null }
    ],
    activeSkuId: "s1",
    activeBrandId: "b1",
    log: []
  };
}
