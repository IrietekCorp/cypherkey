import { initTheme } from './theme';

initTheme();

/**
 * The seat request, and why it opens a mail client rather than posting anywhere.
 *
 * There is no endpoint to post to. Building one means a table, a rate limit, a consent
 * record and a way to delete what it collects — real work that belongs to M3, not a
 * detail of a landing page.
 *
 * What a form must never do in the meantime is *look* like it worked. A field that
 * accepts an address, says "request received" and drops it is the same lie whether it is
 * deliberate or an oversight, and this is a product whose entire argument is that it
 * does not keep what it does not need. So the submit composes a message the visitor can
 * see and send themselves, and the confirmation says exactly that.
 */

const ADDRESS = 'hello@cypherkey.io';

const form = document.querySelector<HTMLFormElement>('[data-beta-form]');
const note = document.querySelector<HTMLElement>('[data-beta-note]');

form?.addEventListener('submit', (event) => {
  event.preventDefault();

  const field = form.querySelector<HTMLInputElement>('input[type="email"]');
  const address = field?.value.trim() ?? '';
  if (address === '') return;

  const subject = encodeURIComponent('CypherKey private beta — seat request');
  const body = encodeURIComponent(
    [
      `Please keep a beta seat for ${address}.`,
      '',
      'Browser and OS:',
      'Do you type with dictation or an on-screen keyboard?',
    ].join('\n'),
  );
  window.location.href = `mailto:${ADDRESS}?subject=${subject}&body=${body}`;

  if (note !== null) {
    note.hidden = false;
    note.textContent = `Your mail client should be opening a message to ${ADDRESS}. Send it and the seat is requested — we only email on milestone releases, nothing else, ever.`;
  }
  field?.blur();
});
