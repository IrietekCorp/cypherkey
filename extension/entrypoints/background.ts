import { defineBackground } from 'wxt/utils/define-background';

/**
 * The background service worker holds no key material. Under MV3 it is evicted without
 * warning, so anything it held would vanish mid-session anyway — and A-5 already says
 * the vault key lives in memory only, for the life of an unlock.
 */
export default defineBackground(() => {});
