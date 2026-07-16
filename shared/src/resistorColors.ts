/**
 * Resistor color-code palette (0-9: Black, Brown, Red, Orange, Yellow, Green,
 * Blue, Violet, Grey, White) — the standard digit-to-color mapping used
 * wherever this app encodes a two-digit number (elevation, tunnel Y depth) as
 * a pair of colored bands, the way a resistor encodes its value.
 */
export const RESISTOR_COLORS: [number, number, number][] = [
  [26, 26, 26], // 0 black
  [123, 63, 0], // 1 brown
  [211, 47, 47], // 2 red
  [230, 126, 34], // 3 orange
  [241, 196, 15], // 4 yellow
  [46, 125, 50], // 5 green
  [21, 101, 192], // 6 blue
  [123, 31, 162], // 7 violet
  [117, 117, 117], // 8 grey
  [245, 245, 245], // 9 white
];

export function resistorColorHex(digit: number): string {
  const [r, g, b] = RESISTOR_COLORS[((digit % 10) + 10) % 10];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Tens/ones digits of a (possibly negative) value, continuous across zero. */
export function digitBands(value: number): { tens: number; ones: number } {
  const v = Math.floor(value);
  const tens = ((Math.floor(v / 10) % 10) + 10) % 10;
  const ones = ((v % 10) + 10) % 10;
  return { tens, ones };
}
