# Vibe Slots design

Accepted on 2026-11-09 for a future LimitBar sidebar style. Open the
[standalone preview](vibe-slots-preview.html) in a browser to see both sizes and try
the lever with sample values.

## Indicator

- Use a 36 × 36 px cabinet for one limit and a 36 × 56 px cabinet for two.
- Use two reels with 15 px digits for each limit. When both windows are present,
  put the 5-hour window above Weekly with a 5 px gap.
- Place one centered percent sign below the reels. Keep window names in the
  indicator description and details rather than on the cabinet.
- Use a graphite cabinet, dark shaded reels, a brass inset border, and a red
  handle with a gradient. Color digits by the remaining quota in both display modes.

## Values and movement

- Show the selected `left` or `used` value. Display ordinary values on the two
  reels and show one star emoji per reel at exactly 100% left or one skull emoji
  per reel at exactly 100% used. Keep values below 100% numeric.
- Pull the handle vertically around a fixed mount. Enlarge the knob briefly as it
  approaches the viewer and give the lever a small rebound on its return.
- Start the reels on the return stroke. Stop the reels in order, top row first,
  with a slight overshoot. The preview completes a spin in about one second and
  displays the result immediately when reduced motion is enabled.

The preview is the reference for the visual treatment and manual spin. The trigger
and timing for automatic updates in LimitBar were open at acceptance.

## Integration note

LimitBar uses this design for the `Vibe Slots` sidebar style. See
[Display settings](../README.md#what-it-looks-like) for the live refresh behavior.
