// Only interpret explicit whole-number answers to the current 1–10 question.
// Keep the original transcript in the UI; never infer scores from severity words.
export function parsePainScore(raw, { allowClockNotation = false, allowDecimal = false } = {}) {
  let value = String(raw ?? '').toLowerCase().replace(/[’]/g, "'").trim().replace(/[.!?]+$/, '').trim();
  const words = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
  value = value.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => String(words.indexOf(word)));
  value = value.replace(/^(?:(?:i think|i guess|probably|about|around)\s+)+/, '');
  value = value.replace(/^(?:(?:my )?pain(?: level| score)? is|(?:it is|it's)|i(?: would|'d) (?:say|rate it)|i rate (?:it|my pain)(?: as)?|(?:a )?(?:level|score)(?: of)?)\s+/, '');
  value = value.replace(/^(?:about |around |a )+/, '');
  // Speech recognition can render a short score answer like "it's two" as "it's 2:00".
  // Only the caller's known pain-question context may enable this exact form.
  if (allowClockNotation) {
    const clockMatch = value.match(/^(10|[1-9]):00$/);
    if (clockMatch) return Number(clockMatch[1]);
  }
  const match = value.match(allowDecimal
    ? /^(10|[1-9](?:\.\d+)?)(?:\s*(?:\/|out of)\s*10)?$/
    : /^(10|[1-9])(?:\s*(?:\/|out of)\s*10)?$/);
  return match && Number(match[1]) <= 10 ? Number(match[1]) : null;
}
