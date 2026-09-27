// src/ui/format.js — number formatting shared by the HUD and the narrator.
// Rules (SPEC §5.4): counts use en-US grouping; percentages have 0 decimals (1 below 10); energy has 1 decimal.

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Narrow no-break space: keeps "T 2,480" on one line without a full word gap. */
export const NNBSP = ' ';

export const fmtInt = (v) => nf0.format(Math.round(v) || 0);

/** Percent value (0–100) → "34", "4.6", "0". */
export function fmtPct(v) {
  if (!(v > 0)) return '0';
  return v < 9.95 ? v.toFixed(1) : String(Math.round(v));
}

/** Energy → "250,000.0". */
export const fmtE = (v) => nf1.format(v);

/** A signal / morphogen value: 2 significant decimals, "0.18", "2.19", "12.4". */
export function fmtSig(v) {
  const a = Math.abs(v);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** A multiplier or ratio → "1.2", "10.8" (one decimal, trailing .0 dropped). */
export function fmtX(v) {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Tick → "T 2,480" (narrow no-break space). */
export const fmtTick = (t) => 'T' + NNBSP + fmtInt(t);

/** Ticks per second readout: 7.5, 15 … 480, 0 = MAX. */
export function fmtSpeed(tps) {
  if (tps === 0) return 'MAX';
  return Number.isInteger(tps) ? String(tps) : tps.toFixed(1);
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 37 → "Thirty-seven" (capitalised); ≥ 100 falls back to digits. */
export function numberWord(n, capital = true) {
  let w;
  if (!Number.isInteger(n) || n < 0 || n >= 100) w = fmtInt(n);
  else if (n < 20) w = ONES[n];
  else w = TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  return capital ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}
