// How long the app waits in two places — here, so the browser tests wait as
// long as the app does instead of repeating its numbers.

/** A rank has to hold this long before it is celebrated, so typing "100" isn't three rank-ups. */
export const RANK_SETTLE_MS = 600;

/**
 * How long the rank-up notice stays. Just past the moment .rank-up has slid
 * away in styles.css (4.1s, then 0.35s); change the two together.
 */
export const RANK_UP_SHOWN_MS = 4500;
