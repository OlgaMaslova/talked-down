export interface DailyThemeContext {
  title?: string;
  characterName?: string;
}

export interface DailyTheme {
  dayNumber: number;
  name: string;
  family: string;
  treatment: string;
  cssVariables: Record<`--${string}`, string>;
}

interface ThemeFamily {
  name: string;
  hue: number;
  chroma: number;
}

interface ThemeTreatment {
  name: string;
  key: string;
  baseLightness: number;
  titleRole: 'accent' | 'secondary' | 'text';
  titleFont: string;
  titleWeight: number;
  titleStyle: 'normal' | 'italic';
  titleTracking: string;
  titleBorderWidth: string;
  titleBackground: string;
  titlePadding: string;
  titleRadius: string;
  titleLineWidth: string;
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

const THEME_TREATMENTS: readonly ThemeTreatment[] = [
  {
    name: 'Spotlight',
    key: 'spotlight',
    baseLightness: 0.105,
    titleRole: 'accent',
    titleFont: "Georgia, 'Times New Roman', serif",
    titleWeight: 700,
    titleStyle: 'normal',
    titleTracking: '-0.022em',
    titleBorderWidth: '0px',
    titleBackground: 'transparent',
    titlePadding: '0',
    titleRadius: '0px',
    titleLineWidth: '2.75rem',
  },
  {
    name: 'Horizon',
    key: 'horizon',
    baseLightness: 0.16,
    titleRole: 'text',
    titleFont: "'Segoe UI', system-ui, -apple-system, sans-serif",
    titleWeight: 800,
    titleStyle: 'normal',
    titleTracking: '-0.035em',
    titleBorderWidth: '0px',
    titleBackground: 'transparent',
    titlePadding: '0',
    titleRadius: '0px',
    titleLineWidth: '100%',
  },
  {
    name: 'Orbit',
    key: 'orbit',
    baseLightness: 0.125,
    titleRole: 'secondary',
    titleFont: "Georgia, 'Times New Roman', serif",
    titleWeight: 650,
    titleStyle: 'italic',
    titleTracking: '-0.012em',
    titleBorderWidth: '0px',
    titleBackground: 'transparent',
    titlePadding: '0',
    titleRadius: '0px',
    titleLineWidth: '1.2rem',
  },
  {
    name: 'Private Stage',
    key: 'stage',
    baseLightness: 0.095,
    titleRole: 'text',
    titleFont: "Georgia, 'Times New Roman', serif",
    titleWeight: 700,
    titleStyle: 'normal',
    titleTracking: '-0.01em',
    titleBorderWidth: '1px',
    titleBackground: 'color-mix(in oklch, var(--panel-raised) 72%, transparent)',
    titlePadding: '0.45rem 0.55rem',
    titleRadius: '6px',
    titleLineWidth: '0px',
  },
  {
    name: 'Signal',
    key: 'signal',
    baseLightness: 0.14,
    titleRole: 'accent',
    titleFont: "ui-monospace, 'SFMono-Regular', Consolas, monospace",
    titleWeight: 750,
    titleStyle: 'normal',
    titleTracking: '-0.025em',
    titleBorderWidth: '0px',
    titleBackground: 'transparent',
    titlePadding: '0',
    titleRadius: '0px',
    titleLineWidth: '3.5rem',
  },
  {
    name: 'Afterimage',
    key: 'afterimage',
    baseLightness: 0.18,
    titleRole: 'secondary',
    titleFont: "'Segoe UI', system-ui, -apple-system, sans-serif",
    titleWeight: 750,
    titleStyle: 'normal',
    titleTracking: '-0.028em',
    titleBorderWidth: '0px',
    titleBackground: 'transparent',
    titlePadding: '0',
    titleRadius: '0px',
    titleLineWidth: '1.65rem',
  },
];

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
  const base = `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${Math.round(positiveModulo(hue, 360))})`;
  if (alpha === undefined) return base;
  return base.replace(')', ` / ${alpha})`);
}

function getAtmosphereVariables(treatment: ThemeTreatment): Record<`--${string}`, string> {
  switch (treatment.key) {
    case 'horizon':
      return {
        '--body-background':
          'linear-gradient(176deg, var(--ambience-primary) 0, transparent 34%), radial-gradient(ellipse at 50% 108%, var(--ambience-secondary) 0, transparent 56%), var(--bg)',
        '--game-background':
          'linear-gradient(180deg, color-mix(in oklch, var(--panel-raised) 72%, var(--accent-soft)) 0, var(--panel) 34%, color-mix(in oklch, var(--panel) 86%, var(--accent-2-soft)) 100%)',
        '--header-background':
          'linear-gradient(180deg, color-mix(in oklch, var(--panel-raised) 76%, var(--accent-soft)), color-mix(in oklch, var(--panel) 88%, var(--accent-2-soft)))',
        '--chat-background':
          'linear-gradient(180deg, color-mix(in oklch, var(--panel) 92%, var(--accent-soft)), var(--panel) 38%)',
        '--composer-background': 'color-mix(in oklch, var(--panel) 88%, var(--accent-2-soft))',
        '--topbar-background': 'color-mix(in oklch, var(--bg) 56%, var(--panel-raised))',
      };
    case 'orbit':
      return {
        '--body-background':
          'radial-gradient(circle at var(--ambient-x) var(--ambient-y), var(--ambience-primary) 0, transparent 24rem), radial-gradient(circle at 12% 76%, var(--ambience-secondary) 0, transparent 26rem), radial-gradient(circle at 88% 88%, var(--ambience-tertiary) 0, transparent 21rem), var(--bg)',
        '--game-background':
          'radial-gradient(circle at 92% 8%, var(--surface-glint) 0, transparent 18rem), radial-gradient(circle at 4% 88%, var(--ambience-secondary) 0, transparent 24rem), var(--panel)',
        '--header-background':
          'radial-gradient(circle at 88% 10%, var(--ambience-primary) 0, transparent 17rem), radial-gradient(circle at 4% 100%, var(--ambience-secondary) 0, transparent 15rem), var(--panel)',
        '--chat-background':
          'radial-gradient(circle at 100% 18%, var(--surface-glint) 0, transparent 30rem), color-mix(in oklch, var(--panel) 94%, var(--accent-2-soft))',
        '--composer-background': 'color-mix(in oklch, var(--panel-2) 90%, var(--accent-soft))',
        '--topbar-background': 'color-mix(in oklch, var(--bg) 68%, var(--panel-2))',
      };
    case 'stage':
      return {
        '--body-background':
          'radial-gradient(ellipse at 50% -8%, var(--ambience-primary) 0, transparent 42rem), linear-gradient(90deg, color-mix(in oklch, var(--bg) 72%, black) 0, var(--bg) 28%, var(--bg) 72%, color-mix(in oklch, var(--bg) 72%, black) 100%)',
        '--game-background':
          'radial-gradient(ellipse at 50% 0, var(--surface-glint) 0, transparent 34rem), linear-gradient(90deg, color-mix(in oklch, var(--panel) 78%, black), var(--panel) 24%, var(--panel) 76%, color-mix(in oklch, var(--panel) 78%, black))',
        '--header-background':
          'radial-gradient(ellipse at 50% -20%, var(--ambience-primary) 0, transparent 23rem), color-mix(in oklch, var(--panel) 90%, black)',
        '--chat-background':
          'linear-gradient(90deg, color-mix(in oklch, var(--panel) 88%, black), var(--panel) 10%, var(--panel) 90%, color-mix(in oklch, var(--panel) 88%, black))',
        '--composer-background': 'color-mix(in oklch, var(--panel-2) 86%, black)',
        '--topbar-background': 'color-mix(in oklch, var(--bg) 76%, black)',
      };
    case 'signal':
      return {
        '--body-background':
          'linear-gradient(132deg, transparent 0 42%, var(--ambience-primary) 42% 58%, transparent 58%), radial-gradient(circle at 14% 82%, var(--ambience-secondary) 0, transparent 30rem), var(--bg)',
        '--game-background':
          'linear-gradient(132deg, transparent 0 57%, var(--surface-glint) 57% 66%, transparent 66%), color-mix(in oklch, var(--panel) 92%, var(--accent-soft))',
        '--header-background':
          'linear-gradient(132deg, color-mix(in oklch, var(--panel-2) 90%, var(--accent-soft)) 0 62%, color-mix(in oklch, var(--panel) 84%, var(--accent-2-soft)) 62%)',
        '--chat-background':
          'linear-gradient(132deg, transparent 0 68%, var(--surface-glint) 68% 76%, transparent 76%), var(--panel)',
        '--composer-background': 'color-mix(in oklch, var(--panel-2) 88%, var(--accent-2-soft))',
        '--topbar-background': 'color-mix(in oklch, var(--bg) 58%, var(--accent-soft))',
      };
    case 'afterimage':
      return {
        '--body-background':
          'radial-gradient(ellipse at 18% 8%, var(--ambience-primary) 0, transparent 34rem), radial-gradient(ellipse at 84% 32%, var(--ambience-secondary) 0, transparent 31rem), radial-gradient(ellipse at 44% 112%, var(--ambience-tertiary) 0, transparent 38rem), var(--bg)',
        '--game-background':
          'radial-gradient(ellipse at 0 0, var(--surface-glint) 0, transparent 25rem), radial-gradient(ellipse at 100% 100%, var(--ambience-secondary) 0, transparent 27rem), color-mix(in oklch, var(--panel) 90%, var(--accent-soft))',
        '--header-background':
          'radial-gradient(ellipse at 4% 0, var(--ambience-primary) 0, transparent 21rem), radial-gradient(ellipse at 100% 90%, var(--ambience-secondary) 0, transparent 18rem), var(--panel)',
        '--chat-background':
          'radial-gradient(ellipse at 100% 20%, var(--surface-glint) 0, transparent 28rem), color-mix(in oklch, var(--panel) 90%, var(--accent-2-soft))',
        '--composer-background': 'color-mix(in oklch, var(--panel-2) 82%, var(--accent-soft))',
        '--topbar-background': 'color-mix(in oklch, var(--bg) 52%, var(--panel-raised))',
      };
    case 'spotlight':
    default:
      return {
        '--body-background':
          'radial-gradient(circle at var(--ambient-x) var(--ambient-y), var(--ambience-primary) 0, transparent 38rem), radial-gradient(circle at 10% 84%, var(--ambience-secondary) 0, transparent 34rem), var(--bg)',
        '--game-background':
          'radial-gradient(circle at var(--ambient-x) 0%, var(--surface-glint) 0, transparent 30rem), var(--panel)',
        '--header-background':
          'radial-gradient(circle at 88% -30%, var(--surface-glint) 0, transparent 17rem), linear-gradient(180deg, var(--panel-2), var(--panel))',
        '--chat-background': 'color-mix(in oklch, var(--panel) 94%, var(--accent-soft))',
        '--composer-background': 'color-mix(in oklch, var(--panel-2) 92%, var(--accent-soft))',
        '--topbar-background': 'color-mix(in oklch, var(--bg) 72%, var(--panel-2))',
      };
  }
}

/**
 * Builds the visual atmosphere for one negotiation.
 *
 * Day number is deliberately the sole seed: the already-played payload does
 * not include scenario copy, so day-only color and treatment choices guarantee
 * that live play, replay, archive playback, and results all render identically.
 * Scenario context is accepted for future non-visual details without making
 * the daily identity depend on payload shape.
 */
export function getDailyTheme(dayNumber: number, _context: DailyThemeContext = {}): DailyTheme {
  const normalizedDay = Math.max(1, Math.trunc(dayNumber));
  const seed = mixDay(normalizedDay);
  const family = THEME_FAMILIES[positiveModulo(normalizedDay - 1, THEME_FAMILIES.length)];
  const treatment = THEME_TREATMENTS[positiveModulo(seed, THEME_TREATMENTS.length)];
  const hueOffset = ((seed >>> 8) % 29) - 14;
  const primaryHue = family.hue + hueOffset;
  const secondaryHue = primaryHue + 82 + ((seed >>> 16) % 35);
  const tertiaryHue = primaryHue + 176 + ((seed >>> 21) % 25);
  const ambientX = 14 + (seed % 72);
  const ambientY = 6 + ((seed >>> 7) % 52);
  const panelLightness = treatment.baseLightness + 0.05;
  const titleColor =
    treatment.titleRole === 'accent'
      ? formatOklch(0.86, Math.max(0.1, family.chroma - 0.005), primaryHue)
      : treatment.titleRole === 'secondary'
        ? formatOklch(0.875, 0.115, secondaryHue)
        : formatOklch(0.97, 0.014, primaryHue);
  const titleShadow =
    treatment.key === 'spotlight'
      ? `0 0 1.4rem ${formatOklch(0.62, family.chroma, primaryHue, 0.24)}`
      : treatment.key === 'afterimage'
        ? `0.08em 0.08em 0 ${formatOklch(0.35, 0.09, tertiaryHue, 0.42)}`
        : 'none';

  return {
    dayNumber: normalizedDay,
    name: `${family.name} ${treatment.name}`,
    family: family.name.toLowerCase(),
    treatment: treatment.key,
    cssVariables: {
      '--bg': formatOklch(treatment.baseLightness, 0.038, primaryHue),
      '--panel': formatOklch(panelLightness, 0.043, primaryHue),
      '--panel-2': formatOklch(panelLightness + 0.04, 0.05, primaryHue),
      '--panel-raised': formatOklch(panelLightness + 0.075, 0.055, primaryHue),
      '--border': formatOklch(panelLightness + 0.17, 0.055, primaryHue),
      '--border-strong': formatOklch(panelLightness + 0.29, 0.07, primaryHue),
      '--text': formatOklch(0.965, 0.014, primaryHue),
      '--text-dim': formatOklch(0.78, 0.03, primaryHue),
      '--accent': formatOklch(0.82, family.chroma, primaryHue),
      '--accent-hover': formatOklch(0.89, Math.max(0.085, family.chroma - 0.015), primaryHue),
      '--accent-soft': formatOklch(panelLightness + 0.105, Math.min(0.09, family.chroma * 0.66), primaryHue),
      '--accent-ink': formatOklch(0.14, 0.03, primaryHue),
      '--accent-2': formatOklch(0.84, 0.115, secondaryHue),
      '--accent-2-soft': formatOklch(panelLightness + 0.1, 0.07, secondaryHue),
      '--accent-2-ink': formatOklch(0.135, 0.03, secondaryHue),
      '--bubble-char': formatOklch(panelLightness + 0.055, 0.05, primaryHue),
      '--bubble-user': formatOklch(panelLightness + 0.09, 0.075, secondaryHue),
      '--ambience-primary': formatOklch(0.48, Math.min(0.16, family.chroma + 0.02), primaryHue, 0.44),
      '--ambience-secondary': formatOklch(0.45, 0.13, secondaryHue, 0.3),
      '--ambience-tertiary': formatOklch(0.42, 0.11, tertiaryHue, 0.23),
      '--surface-glint': formatOklch(0.9, 0.1, primaryHue, 0.12),
      '--focus-ring': formatOklch(0.93, 0.12, primaryHue),
      '--shadow-color': formatOklch(0.025, 0.025, primaryHue, 0.68),
      '--ambient-x': `${ambientX}%`,
      '--ambient-y': `${ambientY}%`,
      '--title-color': titleColor,
      '--title-shadow': titleShadow,
      '--title-font': treatment.titleFont,
      '--title-weight': String(treatment.titleWeight),
      '--title-style': treatment.titleStyle,
      '--title-tracking': treatment.titleTracking,
      '--title-border-width': treatment.titleBorderWidth,
      '--title-background': treatment.titleBackground,
      '--title-padding': treatment.titlePadding,
      '--title-radius': treatment.titleRadius,
      '--title-line-width': treatment.titleLineWidth,
      '--title-line-color': treatment.titleRole === 'secondary' ? 'var(--accent)' : 'var(--accent-2)',
      '--title-line-display': treatment.titleLineWidth === '0px' ? 'none' : 'block',
      ...getAtmosphereVariables(treatment),
    },
  };
}

export function applyDailyTheme(theme: DailyTheme): void {
  const root = document.documentElement;
  for (const [property, value] of Object.entries(theme.cssVariables)) {
    root.style.setProperty(property, value);
  }
  root.dataset.dailyTheme = theme.family;
  root.dataset.dailyThemeTreatment = theme.treatment;
  root.dataset.dailyThemeDay = String(theme.dayNumber);

  const themeColor = theme.cssVariables['--bg'];
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor);
}
