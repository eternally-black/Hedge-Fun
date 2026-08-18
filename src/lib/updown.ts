// The trading WINDOW of a crypto Up/Down market, read off its own question
// ("Bitcoin Up or Down - August 18, 5:10PM-5:15PM ET").
//
// Why this is a module and not a display detail: Polymarket runs several series over the same
// asset — five-minute windows and a fifteen-minute one — and two of them can END at the same
// minute while being completely different bets. On 2026-08-18 the deck served the 5:10-5:15 window
// at 51/50 (an honest coin flip: it had not opened yet) beside Polymarket's own 5:00-5:15 market
// showing 69/32 (eleven minutes in, with the price up). Same countdown, same truncated title, wildly
// different price — which is how a correct number reads as a lie.
//
// `lengthMin` comes from the two labels rather than from any timezone maths: the END is already
// known exactly (resolutionDeadline), so the start is simply end minus the length.
export function upDownWindow(question: string): { label: string; lengthMin: number } | null {
  const m = question.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(et|edt|est|utc|gmt)?/i,
  );
  if (!m) return null;
  const [, h1, m1 = "00", ap1, h2, m2 = "00", ap2, zone] = m;
  const mins = (h: string, mm: string, ap: string) =>
    ((Number(h) % 12) + (ap.toLowerCase() === "pm" ? 12 : 0)) * 60 + Number(mm);
  const lengthMin = (((mins(h2, m2, ap2) - mins(h1, m1, ap1)) % 1440) + 1440) % 1440;
  if (lengthMin <= 0 || lengthMin > 24 * 60) return null;
  const at = (h: string, mm: string) => `${Number(h)}:${mm}`;
  // One meridiem when both ends share it, which is the usual case for these windows.
  const head = ap1.toLowerCase() === ap2.toLowerCase() ? at(h1, m1) : `${at(h1, m1)}${ap1.toUpperCase()}`;
  return { label: `${head}–${at(h2, m2)}${ap2.toUpperCase()}${zone ? " " + zone.toUpperCase() : ""}`, lengthMin };
}

// The shortest window the deck will serve. Polymarket runs Up/Down series down to five minutes, and
// the owner's ruling (2026-08-18) is that those are a DIFFERENT product: a card for the five minutes
// you are living through, which needs a live price feed, a live chart and an entry window measured in
// seconds — none of which exists yet. Until it does they are cut, rather than shipped as an ordinary
// card whose price is either a coin flip (not started) or already decided (nearly over).
export const MIN_UPDOWN_WINDOW_MIN = 15;

// Is this market servable as an ordinary deck card? Two rules, both learned the same day:
//   - the window must be long enough to be an ordinary bet (above);
//   - and it must have OPENED. A window that has not started is a pure coin flip whose price says
//     nothing about anything, and shown beside its running sibling — same asset, same end time, same
//     truncated title — it makes a correct price look like a lie.
// Anything we cannot parse (every non-Up/Down market) is servable, which is what it is.
export function servableUpDown(question: string, deadlineMs: number, nowMs: number): boolean {
  const w = upDownWindow(question);
  if (!w) return true;
  if (w.lengthMin < MIN_UPDOWN_WINDOW_MIN) return false;
  return nowMs >= deadlineMs - w.lengthMin * 60_000;
}
