export interface DailyThemeContext {
  title?: string;
  characterName?: string;
}

export interface DailyTheme {
  dayNumber: number;
  name: string;
  family: string;
  cssVariables: Record<`--${string}`, string>;
}

interface ThemeFamily {
  name: string;
  hue: number;
  chroma: number;
}

const THEME_FAMILIES: readonly ThemeFamily[] = [
  { name: 'Copper', hue: 48, chroma: 0.135 },
  { name: 'Citrine', hue: 88, chroma: 0.125 },
  { name: 'Moss', hue: 132, chroma: 0.12 },
  { name: 'Verdigris', hue: 169, chroma: 0.105 },
  { name: 'Harbor', hue: 205, chroma: 0.105 },
  { name: 'Cobalt', hue: 252, chroma: 0.12 },
  { name: 'Indigo', hue: 282, chroma: 0.12 },
  { name: 'Orchid', hue: 319, chroma: 0.115 },
  { name: 'Raspberry', hue: 353, chroma: 0.125 },
  { name: 'Ember', hue: 24, chroma: 0.135 },
];

const ATMOSPHERES = [
  'Back Room',
  'Last Train',
  'Night Market',
  'Signal Room',
  'Late Shift',
  'Blue Hour',
  'Private Booth',
  'After Hours',
] as const;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** A small integer hash used only to position decorative ambience deterministically. */
function mixDay(dayNumber: number): number {
  let value = Math.max(1, Math.trunc(dayNumber)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function formatOklch(lightness: number, chroma: number, hue: number, alpha?: number): string {
  const base = `oklch(${lightness} ${chroma.toFixed(3)} ${Math.round(positiveModulo(hue, 360))})`;
  if (alpha === undefined) return base;
  return base.replace(')', ` / ${alpha})`);
}

/**
 * Builds the visual atmosphere for one negotiation.
 *
 * Day number is deliberately the sole color seed: the already-played payload
 * does not include scenario copy, so day-only colors guarantee that today's
 * live game, its replay, archive playback, and its result screen all match.
 * Scenario context is accepted for future non-color details without making
 * the visual identity depend on payload shape.
 */
export function getDailyTheme(dayNumber: number, _context: DailyThemeContext = {}): DailyTheme {
  const normalizedDay = Math.max(1, Math.trunc(dayNumber));
  const seed = mixDay(normalizedDay);
  const family = THEME_FAMILIES[positiveModulo(normalizedDay - 1, THEME_FAMILIES.length)];
  const atmosphere = ATMOSPHERES[positiveModulo(seed, ATMOSPHERES.length)];
  const hueOffset = ((seed >>> 8) % 25) - 12;
  const primaryHue = family.hue + hueOffset;
  const secondaryHue = primaryHue + 82 + ((seed >>> 16) % 35);
  const ambientX = 18 + (seed % 65);
  const ambientY = 8 + ((seed >>> 7) % 48);

  return {
    dayNumber: normalizedDay,
    name: `${family.name} ${atmosphere}`,
    family: family.name.toLowerCase(),
    cssVariables: {
      '--bg': formatOklch(0.125, 0.018, primaryHue),
      '--panel': formatOklch(0.175, 0.025, primaryHue),
      '--panel-2': formatOklch(0.215, 0.032, primaryHue),
      '--panel-raised': formatOklch(0.245, 0.037, primaryHue),
      '--border': formatOklch(0.35, 0.043, primaryHue),
      '--border-strong': formatOklch(0.47, 0.06, primaryHue),
      '--text': formatOklch(0.955, 0.012, primaryHue),
      '--text-dim': formatOklch(0.75, 0.026, primaryHue),
      '--accent': formatOklch(0.79, family.chroma, primaryHue),
      '--accent-hover': formatOklch(0.86, Math.max(0.08, family.chroma - 0.015), primaryHue),
      '--accent-soft': formatOklch(0.29, Math.min(0.075, family.chroma * 0.58), primaryHue),
      '--accent-ink': formatOklch(0.15, 0.025, primaryHue),
      '--accent-2': formatOklch(0.79, 0.105, secondaryHue),
      '--accent-2-soft': formatOklch(0.285, 0.058, secondaryHue),
      '--accent-2-ink': formatOklch(0.145, 0.025, secondaryHue),
      '--bubble-char': formatOklch(0.235, 0.035, primaryHue),
      '--bubble-user': formatOklch(0.275, 0.055, secondaryHue),
      '--ambience-primary': formatOklch(0.42, 0.13, primaryHue, 0.34),
      '--ambience-secondary': formatOklch(0.38, 0.1, secondaryHue, 0.2),
      '--surface-glint': formatOklch(0.88, 0.08, primaryHue, 0.08),
      '--focus-ring': formatOklch(0.9, 0.12, primaryHue),
      '--shadow-color': formatOklch(0.04, 0.018, primaryHue, 0.62),
      '--ambient-x': `${ambientX}%`,
      '--ambient-y': `${ambientY}%`,
    },
  };
}

export function applyDailyTheme(theme: DailyTheme): void {
  const root = document.documentElement;
  for (const [property, value] of Object.entries(theme.cssVariables)) {
    root.style.setProperty(property, value);
  }
  root.dataset.dailyTheme = theme.family;
  root.dataset.dailyThemeDay = String(theme.dayNumber);

  const themeColor = theme.cssVariables['--bg'];
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor);
}
