import { defineContentScript } from 'wxt/utils/define-content-script';

/**
 * Placeholder. Field detection and domain-bound autofill are M2-10, which is the
 * highest-risk ticket in the milestone: nothing here may fill anything until the
 * registrable-domain and punycode checks exist.
 */
export default defineContentScript({
  matches: [],
  main() {},
});
