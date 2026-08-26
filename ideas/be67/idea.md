# be67

**Founder:** saksham
**Created:** 2026-08-26T17:07:57.383Z

## Origin

A tool that reads Indian GST filings and flags input-credit mismatches before they trigger a notice, sold to CA firms managing 50+ clients.

## Case against

The prosecution makes the following case against this business:

1. **You are building a feature that incumbent compliance suites already provide.** Pre-filing Input Tax Credit (ITC) reconciliation (matching GSTR-2B against GSTR-3B and purchase registers) is not an unaddressed white space; it is the core selling point of established Indian tax platforms like Clear (ClearTax), Masters India, IRIS GST, and TallyPrime. CAs will not export data out of their primary accounting/filing software into a standalone, single-purpose tool just to perform a check their current vendor already claims to do.
2. **Indian CAs are notoriously price-sensitive with low ACVs.** Mid-tier CA firms managing ~50 clients typically operate on razor-thin compliance margins. They resist subscription SaaS, often relying on legacy on-premise tools (Winman, Computax) or free government offline utilities. The willingness to pay for an add-on point solution is near zero.
3. **The unit economics of selling to Indian CAs are fatal.** Acquiring fragmented, traditional CA firms requires high-touch field sales, WhatsApp demos, and endless support. When your customer acquisition cost (CAC) meets an Annual Contract Value (ACV) capped by Indian CA software pricing norms (often under ₹10,000–₹20,000/year), the payback period is unviable.
4. **Platform risk and GSTN API gatekeeping.** Accessing client GSTR data programmatically requires either expensive GST Suvidha Provider (GSP) partnerships, complex multi-factor OTP workflows from reluctant end-clients, or fragile portal scraping that breaks with every GSTN UI change. Incumbents already hold official GSP licenses and established infrastructure.

## Assumption

At least 15% of Indian CA firms managing 50+ clients are willing to pay more than ₹15,000/year for a standalone mismatch tool over the built-in reconciliation modules in ClearTax or TallyPrime.
