"use strict";

// D-08 (docs/DECISIONS.md): Gemini 3.7 Flash introductory pricing,
// $0.75/M input tokens, $3.75/M output tokens. Thinking tokens bill as
// output (D-08 amendment) -- LiteLLM's completion_tokens already
// includes reasoning_tokens + text_tokens combined, so no separate
// accounting is needed here. Revisit 31 Dec 2026 when intro pricing
// expires and rates double to $1.50/$7.50.
const GEMINI_FLASH_IN_PER_M = 0.75;
const GEMINI_FLASH_OUT_PER_M = 3.75;

function geminiFlashCost({ tokensIn = 0, tokensOut = 0 }) {
	return (tokensIn * GEMINI_FLASH_IN_PER_M + tokensOut * GEMINI_FLASH_OUT_PER_M) / 1_000_000;
}

module.exports = { geminiFlashCost, GEMINI_FLASH_IN_PER_M, GEMINI_FLASH_OUT_PER_M };
