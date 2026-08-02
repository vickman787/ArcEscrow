# ArcEscrow brand assets

The mark is the "Trust Triangle": two cobalt nodes at the base (buyer and seller)
and a gold node at the apex (arbiter) — the three parties to every escrow.

| File | Size | Use |
| --- | --- | --- |
| `arcescrow-mark.svg` | vector | Source of truth. Theme-aware: switches to lighter cobalt/gold on dark backgrounds via `prefers-color-scheme`. Used in-app as favicon and navbar logo. |
| `arcescrow-x-avatar-400.png` | 400×400 | X / social profile picture. Mark is centered well inside the circular safe area, so it survives the circle crop. |
| `arcescrow-x-banner-1500x500.png` | 1500×500 | X profile banner. Content is centre-aligned to stay clear of the avatar, which X overlays on the lower left. |
| `arcescrow-logo-dark-512.png` | 512×512 | Square app icon on the dark brand tile. For Circle Console, Google account photo, and anywhere a solid square icon is required. |
| `arcescrow-mark-transparent-512.png` | 512×512 | Mark only, transparent background, darker cobalt/gold tuned for **light** backgrounds (white email bodies, light docs). |

## Palette

| Token | Light backgrounds | Dark backgrounds |
| --- | --- | --- |
| Cobalt (primary) | `#2451C4` | `#6D94E6` |
| Gold (accent) | `#C17D0F` | `#EAB648` |
| Ground | `#FBFAF6` | `#0A0E1A` |

Display type is Unbounded 800; body type is Work Sans 400/500. Both are
self-hosted in `src/index.css` as base64 woff2, so no CDN is needed.

## Note on the Circle OTP email

The "Your ArcEscrow verification code" email is composed and sent by Circle, not
by this app — the server only calls `/v1/w3s/users/email/token`
(`server/circle-api.js`). Its logo, sender name, and links are configured in the
Circle Developer Console, so adding the logo there is a dashboard change rather
than a code change. Upload `arcescrow-logo-dark-512.png` (or the transparent
variant if Circle composites onto white).
