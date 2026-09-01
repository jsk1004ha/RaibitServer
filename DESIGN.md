---
version: alpha
name: raibit-supabase-inspired
description: "A RAIBIT SERVER adaptation of the Supabase-inspired editorial design system, preserving its layout, spacing, component, and elevation grammar across light and dark themes while using RAIBIT navy and Wanted Sans."

colors:
  primary: "#091936"
  primary-deep: "#071229"
  primary-soft: "#e9eef6"
  ink: "#171717"
  ink-secondary: "#212121"
  ink-mute: "#707070"
  ink-mute-2: "#9a9a9a"
  ink-faint: "#b2b2b2"
  on-primary: "#ffffff"
  on-dark: "#ffffff"
  canvas: "#ffffff"
  canvas-soft: "#fafafa"
  canvas-night: "#1c1c1c"
  canvas-night-soft: "#202020"
  hairline: "#dfdfdf"
  hairline-strong: "#c7c7c7"
  hairline-cool: "#ededed"
  hairline-cool-2: "#efefef"
  hairline-cool-3: "#d4d4d4"
  accent-purple: "#6b01c2"
  accent-violet: "#644fc1"
  accent-purple-soft: "#eddbf9"
  accent-yellow: "#ffdb13"
  accent-tomato: "#ff2201"
  accent-pink: "#c7007e"
  accent-indigo: "#054cff"
  accent-crimson: "#e2005a"

colorsDark:
  primary: "#7fa4dd"
  primary-deep: "#6d90c8"
  primary-soft: "#1d3150"
  primary-foreground: "#071229"
  ink: "#f4f6f8"
  ink-secondary: "#d3dae3"
  ink-mute: "#a9b4c3"
  ink-mute-2: "#8a95a4"
  ink-faint: "#758190"
  on-primary: "#071229"
  on-dark: "#f4f6f8"
  canvas: "#11161d"
  canvas-soft: "#181f29"
  card: "#202a36"
  popover: "#2a3645"
  canvas-night: "#090c11"
  canvas-night-soft: "#151b24"
  brand-surface: "#0b1d3a"
  brand-surface-foreground: "#f5f8ff"
  hairline: "#344459"
  hairline-strong: "#708197"
  accent-foreground: "#dce9ff"
  destructive: "#ff7098"
  destructive-foreground: "#260914"
  selection: "rgb(127 164 221 / 32%)"

typography:
  display-xxl:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 64px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -1.92px
  display-xl:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -1.44px
  display-lg:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: -0.72px
  display-md:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: -0.42px
  heading-lg:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  heading-md:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  body-lg:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  body-md:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  button-md:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.0
    letterSpacing: 0
  caption:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  micro:
    fontFamily: "'Wanted Sans', 'Noto Sans KR', system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  code:
    fontFamily: "ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  huge: 64px

components:
  button-primary-navy:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
  button-primary-navy-pressed:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
  button-secondary-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
  button-on-dark:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-dark}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: 8px 16px
  button-link:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.xs}"
    padding: 0px
  text-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: 8px 12px
  card-feature-light:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 32px
  card-service:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 32px
  card-service-featured:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 32px
  card-feature-dark:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 32px
  code-block:
    backgroundColor: "{colors.canvas-night}"
    textColor: "{colors.on-dark}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: 16px
  pill-tag-navy:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  pill-tag-soft:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: 2px 8px
  nav-bar-light:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: 16px 24px
  link-on-light:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: 0px
  footer-light:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-mute}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: 64px 24px
---

## Overview

RAIBIT SERVER's design language is engineered for clarity above all else. Light mode remains the editorial default on `{colors.canvas}` with `{colors.ink}` text. Dark mode maps the same semantic hierarchy onto `{colorsDark.canvas}` with `{colorsDark.ink}` text for low-light and long console sessions. Across both modes, the only consistent chromatic event is the **RAIBIT navy primary**: deep navy in light mode and an illuminated navy tint in dark mode.

Typography runs **Wanted Sans** at weight 500 for display and 400 for body. The display tier uses tight negative letter-spacing (-1.92px at 64px) to pull the rounded humanist letterforms into editorial density. There is no atmospheric gradient or full-bleed photography; both themes preserve the same restrained product-first composition.

The product itself appears as composited UI screenshots on every page: dashboard tables, deployment views, resource panels, log streams. These screenshots are the brand's argument. They sit inside `{rounded.lg}` 12px containers with subtle 1px hairlines, often arranged 2-up or in a floating "stacked panes" composition above the hero band.

**Key Characteristics:**
- Single navy primary (`{colors.primary}` `#091936`) as the only chromatic event; everything else is monochrome.
- Semantic light and dark canvases with a shared greyscale hierarchy and identical information emphasis.
- Custom humanist sans display tier at weight 500 with negative letter-spacing of -1.92px to -0.42px.
- Composited product UI screenshots (dashboard, deployment view, log stream) are the dominant decorative element — never photography, never illustrations.
- Tight 6px / 8px button radii — square-ish, technical, never pill-shaped.
- Code blocks rendered in deep `{colors.canvas-night}` (`#1c1c1c`) with monospace inline code; the brand's developer DNA is visible in every snippet.
- Service tiers use a dark inverted `{colors.canvas-night}` featured tier, not a navy one — the navy is reserved for buttons and dot accents.

## Colors

> **RAIBIT target pages:** home (`/`), `/login`, `/status`, `/console`, and project/service/resource routes.

### Theme Modes
- **System** is the default preference and follows `prefers-color-scheme`.
- **Light** uses `{colors.canvas}` / `{colors.ink}` and the original deep RAIBIT navy primary.
- **Dark** uses `{colorsDark.canvas}` / `{colorsDark.ink}` and `{colorsDark.primary}` so controls retain AA contrast without turning the interface into pure black.
- Theme selection is global, persists in a same-site cookie, and must not require inline boot scripts or new runtime permissions.
- The only preferences are `system`, `light`, and `dark`; Deep dark, custom themes, and any fourth preference are not part of the product contract.

### Brand & Accent
- **RAIBIT Navy** (`{colors.primary}` — `#091936`): The signature CTA color. Filled-button background, brand wordmark accent, dot indicator.
- **RAIBIT Navy Deep** (`{colors.primary-deep}` — `#071229`): Pressed-state lift of the primary.
- **RAIBIT Navy Soft** (`{colors.primary-soft}` — `#e9eef6`): Light navy tint used in chart accents and product UI.
- **Accent Purple** (`{colors.accent-purple}` — `#6b01c2`): Rare accent used in integration logos and chart points; never a button.
- **Accent Violet** (`{colors.accent-violet}` — `#644fc1`): Secondary accent in the same role as accent purple.
- **Accent Yellow** (`{colors.accent-yellow}` — `#ffdb13`): Chart accent / status indicator only.
- **Accent Pink / Crimson / Indigo / Tomato**: Reserved for integration logos and rare chart highlights, never as system colors.
- **Dark Brand Surface** (`{colorsDark.brand-surface}` — `#0b1d3a`) with **Dark Brand Foreground** (`{colorsDark.brand-surface-foreground}` — `#f5f8ff`) is a large RAIBIT brand field only: a hero, identity band, or deliberate large-area surface. It is never a generic control fill.
- **Dark Primary** (`{colorsDark.primary}` — `#7fa4dd`) is reserved for compact CTAs, links, active states, and focus; its filled-control foreground is `{colorsDark.primary-foreground}` / `{colorsDark.on-primary}` (`#071229`). Do not turn this illuminated blue into a large-area background.

### Surface
- **Canvas** (`{colors.canvas}` — `#ffffff`): Default page background.
- **Canvas Soft** (`{colors.canvas-soft}` — `#fafafa`): Barely-tinted off-white for alternating section bands.
- **Canvas Night** (`{colors.canvas-night}` — `#1c1c1c`): Deep near-black used in code blocks, dashboard mockups, featured service tier.
- **Canvas Night Soft** (`{colors.canvas-night-soft}` — `#202020`): Slightly lifted dark for nested chrome.
- **Hairline** (`{colors.hairline}` — `#dfdfdf`): 1px borders on cards and tables.
- **Hairline Strong** (`{colors.hairline-strong}` — `#c7c7c7`): Slightly darker border for emphasis.
- **Hairline Cool** (`{colors.hairline-cool}` — `#ededed`) / **Hairline Cool 2** (`#efefef`) / **Hairline Cool 3** (`#d4d4d4`): The brand's grey ladder for fine chrome work.
- **Dark Canvas** (`{colorsDark.canvas}` — `#11161d`) is the page/app background. **Dark Surface 1** (`{colorsDark.canvas-soft}` — `#181f29`) is the subtle section/muted/secondary layer; **Dark Card** (`{colorsDark.card}` — `#202a36`) is the raised product surface; **Dark Popover** (`{colorsDark.popover}` — `#2a3645`) is the menu/overlay layer.
- **Dark Night** (`{colorsDark.canvas-night}` — `#090c11`) is the code/log well and inverse canvas. **Dark Night Raised** (`{colorsDark.canvas-night-soft}` — `#151b24`) is raised content inside that inverse well. **Dark Hairline** (`{colorsDark.hairline}` — `#344459`) separates decorative surfaces, while **Dark Control Border** (`{colorsDark.hairline-strong}` — `#708197`) is for inputs and outline controls.

### Text
- **Ink** (`{colors.ink}` — `#171717`): Default body text. Near-black, never pure.
- **Ink Secondary** (`{colors.ink-secondary}` — `#212121`): Slightly cooler near-black for body emphasis.
- **Ink Mute** (`{colors.ink-mute}` — `#707070`): Secondary text and helper copy.
- **Ink Mute 2** (`{colors.ink-mute-2}` — `#9a9a9a`): Tertiary text.
- **Ink Faint** (`{colors.ink-faint}` — `#b2b2b2`): Disabled / placeholder text.
- **On Primary** (`{colors.on-primary}` — `#ffffff`): White text on the navy primary fill for strong contrast.
- **On Dark** (`{colors.on-dark}` — `#ffffff`): Text on canvas-night surfaces.
- In dark mode, `{colorsDark.ink}` (`#f4f6f8`) is primary readable text, `{colorsDark.ink-secondary}` (`#d3dae3`) secondary readable text, `{colorsDark.ink-mute}` (`#a9b4c3`) muted readable text, `{colorsDark.ink-mute-2}` (`#8a95a4`) low-emphasis metadata, and `{colorsDark.ink-faint}` (`#758190`) decorative or disabled content only. `{colorsDark.accent-foreground}` (`#dce9ff`) sits on `{colorsDark.primary-soft}`; destructive states use `{colorsDark.destructive}` (`#ff7098`) with `{colorsDark.destructive-foreground}` (`#260914`); selection is `{colorsDark.selection}` (`rgb(127 164 221 / 32%)`).

### Semantic Theme Mapping

| Public semantic aliases | Light contract (unchanged) | Dark mapping |
|---|---|---|
| `--canvas`, `--background` | `#ffffff` | `{colorsDark.canvas}` |
| `--canvas-soft`, `--secondary`, `--muted` | `#fafafa` | `{colorsDark.canvas-soft}` |
| `--card` | `#ffffff` | `{colorsDark.card}` |
| `--popover` | `#ffffff` | `{colorsDark.popover}` |
| `--canvas-night`, `--inverse` | `#1c1c1c` | `{colorsDark.canvas-night}` |
| `--canvas-night-soft`, `--inverse-raised` | `#202020` | `{colorsDark.canvas-night-soft}` |
| `--ink`, `--foreground`, card/popover/inverse foreground | current `#171717` / `#ffffff` roles | `{colorsDark.ink}` |
| `--ink-secondary`, `--secondary-foreground` | `#212121` | `{colorsDark.ink-secondary}` |
| `--ink-mute`, `--muted-foreground` | `#707070` | `{colorsDark.ink-mute}` |
| `--ink-mute-2` | `#9a9a9a` | `{colorsDark.ink-mute-2}` |
| `--ink-faint` | `#b2b2b2` | `{colorsDark.ink-faint}` |
| `--hairline`, `--border`, cool decorative hairlines | current light hairlines | `{colorsDark.hairline}` |
| `--hairline-strong`, `--input` | `#c7c7c7` | `{colorsDark.hairline-strong}` |
| `--primary`, `--ring` | `#091936` | `{colorsDark.primary}` |
| `--primary-foreground` | `#ffffff` | `{colorsDark.primary-foreground}` |
| `--primary-deep` | `#071229` | `{colorsDark.primary-deep}` |
| `--primary-soft`, `--accent` | `#e9eef6` | `{colorsDark.primary-soft}` |
| `--accent-foreground` | `#091936` | `{colorsDark.accent-foreground}` |
| `--destructive` | existing light `color-mix(...)` | `{colorsDark.destructive}` |
| `--destructive-foreground` | `#ffffff` | `{colorsDark.destructive-foreground}` |
| `--brand-surface`, `--brand-surface-foreground` | `#091936` / `#ffffff` | `{colorsDark.brand-surface}` / `{colorsDark.brand-surface-foreground}` |
| `--selection` | `rgb(9 25 54 / 28%)` | `{colorsDark.selection}` |

### Contrast & Effects

- Normal text must meet 4.5:1 contrast, large text 3:1, and compact primary content 4.5:1 against its actual fill. Focus and control boundaries must meet 3:1 against their actual adjacent surface. Decorative elevation surfaces are judged by their border and visual hierarchy rather than a forced 3:1 fill contrast.
- Do not add gradients, glow, glass, backdrop blur, or decorative theme-transition effects. Buttons remain square-ish 6px controls, never oversized pills; the dark hierarchy comes from the semantic surface ladder and borders.

## Typography

### Font Family

The display and UI tier is **Wanted Sans** — an open-source Korean and Latin sans. Fallback chain: `'Noto Sans KR', system-ui, sans-serif`.

Self-host the official Wanted Sans v1.0.3 WOFF2 files with `font-display: swap`. Keep weight 500 for display and preserve the original negative tracking scale.

Code blocks use **system mono** (`ui-monospace`, with Menlo / Monaco / Consolas fallbacks).

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-xxl}` | 64px | 500 | 1.1 | -1.92px | Hero headline |
| `{typography.display-xl}` | 48px | 500 | 1.1 | -1.44px | Section opener |
| `{typography.display-lg}` | 36px | 500 | 1.15 | -0.72px | Sub-section / service tier |
| `{typography.display-md}` | 28px | 500 | 1.2 | -0.42px | Card title |
| `{typography.heading-lg}` | 22px | 500 | 1.2 | 0 | Compact heading |
| `{typography.heading-md}` | 18px | 500 | 1.4 | 0 | Section sub-heading |
| `{typography.body-lg}` | 18px | 400 | 1.55 | 0 | Marketing body lead |
| `{typography.body-md}` | 16px | 400 | 1.5 | 0 | Default UI body |
| `{typography.button-md}` | 14px | 500 | 1.0 | 0 | Button label |
| `{typography.caption}` | 13px | 400 | 1.45 | 0 | Helper, footnote |
| `{typography.micro}` | 12px | 400 | 1.45 | 0 | Pill label, fine print |
| `{typography.code}` | 14px | 400 | 1.5 | 0 | Code block content |

### Principles
- **Weight 500 across display.** Mid-weight reads as engineered, not decorative.
- **Negative tracking on display.** -1.92px at 64px scaling proportionally down — tightens the rounded humanist letterforms into editorial density.
- **Mono for code.** System mono families (Menlo / Monaco) — no proprietary mono webfont.

### Note on Font Substitutes
Wanted Sans is distributed under the SIL Open Font License. Preserve the license alongside the self-hosted font files; use Noto Sans KR only as the Korean fallback.

## Layout

### Spacing System
- **Base unit**: 8px (with 2 / 4 / 12 sub-tokens for fine work).
- **Tokens**: `{spacing.xxs}` 2px · `{spacing.xs}` 4px · `{spacing.sm}` 8px · `{spacing.md}` 12px · `{spacing.lg}` 16px · `{spacing.xl}` 24px · `{spacing.xxl}` 32px · `{spacing.huge}` 64px.
- **Section padding**: 64–96px on marketing surfaces.
- **Card internal padding**: 32px on feature/service cards.

### Grid & Container
- Marketing pages center in a ~1280px container with no edge-bleed; the brand keeps content inside the box.
- Service collapses 4-up → 2-up → 1-up at 1024 / 768 breakpoints.
- Product UI mockups stack 2-up or render as overlapping panes inside the same container.

### Whitespace Philosophy
The brand uses generous 64–96px section padding without atmospheric gradients filling the space. The active semantic canvas—white in light mode, charcoal in dark mode—is the design. Composited product UI mockups break up sections without requiring decoration.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 | Flat, 1px hairline | Default cards |
| 1 | `box-shadow: 0 1px 3px rgba(0,0,0,0.06)` | Subtle card lift |
| 2 | `box-shadow: 0 8px 24px rgba(0,0,0,0.08)` | Floating composited UI mockups |
| 3 | `box-shadow: 0 16px 48px rgba(0,0,0,0.12)` | Modal overlays, deep elevation |

### Decorative Depth
The brand's depth is **product UI mockups** rather than gradients. Stacked dashboard / deployment / log panes composite together with subtle Level 2 shadows to suggest spatial hierarchy.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 4px | Form inputs, hairline tags |
| `{rounded.sm}` | 6px | Buttons (the brand's signature button radius), code blocks |
| `{rounded.md}` | 8px | Compact cards, alerts |
| `{rounded.lg}` | 12px | Service cards, feature cards, product mockups |
| `{rounded.xl}` | 16px | Modal dialogs, large container chrome |
| `{rounded.full}` | 9999px | Pill tags, avatars |

### Photography Geometry
The brand uses minimal photography. Customer logo strips display wordmarks at uniform height (~24–32px) in greyscale; case-study cards (rare) use 4:3 photos inset in `{rounded.lg}` containers.

## Components

### Buttons

**`button-primary-navy`** — the signature CTA.
- Background `{colors.primary}`, text `{colors.on-primary}` (white), type `{typography.button-md}`, padding `{spacing.sm} {spacing.lg}` (8px 16px), rounded `{rounded.sm}` 6px.
- Pressed state `button-primary-navy-pressed` shifts to `{colors.primary-deep}`.

**`button-secondary-outline`** — outline alternative on the active semantic canvas.
- Background `{colors.canvas}`, text `{colors.ink}`, 1px solid `{colors.hairline-strong}` border, same shape.

**`button-on-dark`** — used on dark surfaces / code-block CTAs.
- Background `{colors.canvas-night}`, text `{colors.on-dark}`, same shape.

**`button-link`** — text-only inline button.
- Transparent background, text `{colors.ink}` rendered in `{typography.button-md}`, no padding, with a subtle underline on hover.

### Cards & Containers

**`card-feature-light`** — feature card on white.
- Background `{colors.canvas}`, padding `{spacing.xxl}`, rounded `{rounded.lg}` 12px, 1px `{colors.hairline}` border.

**`card-service`** — standard service tier.
- Background `{colors.canvas}`, padding `{spacing.xxl}`, rounded `{rounded.lg}`, 1px `{colors.hairline}` border. Title in `{typography.heading-lg}`, metric in `{typography.display-md}`, body in `{typography.body-md}`, CTA `button-primary-navy` pinned bottom.

**`card-service-featured`** — inverted dark featured tier.
- Background `{colors.canvas-night}`, text `{colors.on-dark}`, otherwise identical structure.

**`card-feature-dark`** — feature card with deep dark fill.
- Background `{colors.canvas-night}`, text `{colors.on-dark}`, padding `{spacing.xxl}`, rounded `{rounded.lg}`. Used for code-heavy feature explanations.

**`code-block`** — code snippet container.
- Background `{colors.canvas-night}`, text `{colors.on-dark}` rendered in `{typography.code}`. Padding `{spacing.lg}` 16px, rounded `{rounded.sm}` 6px.

### Inputs & Forms

**`text-input`** — standard form input.
- Background `{colors.canvas}`, text `{colors.ink}`, type `{typography.body-md}`, padding `{spacing.sm} {spacing.md}` (8px 12px), rounded `{rounded.sm}` 6px, 1px `{colors.hairline}` border.

### Navigation

**`nav-bar-light`** — legacy token name for the theme-aware top nav across the site.
- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.lg} {spacing.xl}`. Logo on the left, primary nav center, login link + filled `button-primary-navy` on the right.

### Pills, Tags, and Chips

**`pill-tag-navy`** — small navy pill used for "new" or featured indicators.
- Background `{colors.primary}`, text `{colors.on-primary}`, type `{typography.micro}`, padding `{spacing.xxs} {spacing.sm}`, rounded `{rounded.full}`.

**`pill-tag-soft`** — neutral pill on light surfaces.
- Background `{colors.canvas-soft}`, text `{colors.ink}`, otherwise same shape.

### Signature Components

**Composited Product UI Mockups** — multi-layer dashboard / deployment / log pane composites with subtle Level 2 shadows. The product is the brand's argument; mockups sit on the active semantic canvas with no surrounding decoration.

**`link-on-light`** — inline links in body copy.
- Text `{colors.ink}` rendered in `{typography.body-md}` with a persistent underline.

**`footer-light`** — site-wide footer.
- Background `{colors.canvas}`, text `{colors.ink-mute}`, type `{typography.caption}`, padding `{spacing.huge} {spacing.xl}` (64px 24px). Holds 4–5 columns of link groups, social icons, and a small legal row.

## Do's and Don'ts

### Do
- Reserve `{colors.primary}` navy for filled CTAs and the wordmark accent — it should appear sparingly.
- Render display tiers at weight 500 with negative letter-spacing — the engineered tightness is part of the brand.
- Use `{rounded.sm}` 6px for buttons — square-ish radii, never pill-shaped.
- Composite product UI mockups inside `{rounded.lg}` containers with subtle Level 2 shadows.
- Use white `{colors.on-primary}` text on the navy button for strong contrast.
- Apply system mono for every code block.
- Keep hierarchy, focus visibility, and contrast equivalent in system, light, and dark preferences.

### Don't
- Don't introduce additional accent colors as system colors — purples, yellows, and pinks belong inside chart points and integration logos only.
- Don't bump display weight above 500 — the brand's calibrated mid-weight breaks at 600+.
- Don't use pill-shaped buttons; the brand's button radius is square-ish 6px.
- Don't use dark text on the navy button — white is required for contrast.
- Don't add atmospheric gradients to hero bands — the semantic canvas is the design.
- Don't hard-code light-only colors in components; use semantic tokens so dark mode stays complete.

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---|---|
| Wide | ≥ 1440px | Full container width; product mockups at full scale |
| Desktop | 1024–1440px | Default content max-width; service 4-up |
| Tablet | 768–1023px | Service 2-up; mockups simplify to single panel |
| Mobile | < 768px | Service 1-up; hamburger nav; display drops 64 → 36px |

### Touch Targets
- Buttons hit ≥ 36×36px on mobile; vertical padding scales up to maintain WCAG AA minimum.
- Form fields stay at 36px minimum height.

### Collapsing Strategy
- Display tiers stair-step 64 → 48 → 36 → 28 → 22px.
- Product UI mockups simplify to a single primary panel on mobile.
- Service tiers stair-step 4-up → 2-up → 1-up; dark featured tier always distinguished.

### Image Behavior
Product UI mockups use `srcset` with desktop / mobile crops; mobile crops focus on the most actionable inner panel.

## Iteration Guide

1. Focus on ONE component at a time.
2. Reference component names and tokens directly.
3. Run `npx --yes -p @google/design.md@0.4.0 designmd lint DESIGN.md` after edits.
4. Default body to `{typography.body-md}`; use `{typography.code}` for any developer-facing snippet.
5. Keep navy scarce; one filled navy button per viewport.
6. The semantic-canvas commitment is non-negotiable — light and dark must share hierarchy without atmospheric backdrops.
