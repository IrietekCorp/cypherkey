import { createApp } from './app';
import { loadConfigOrExit } from './config';
import { createDb } from './db/client';
import { createMailer, resendTransport } from './mail/client';

const config = loadConfigOrExit();
const db = createDb(config.db);

/**
 * The X-3 failure notice, wired or deliberately absent.
 *
 * This is the line M2-15 was missing. `createMailer`, `resendTransport` and the whole
 * throttle were written and tested behind an injected `Transport`, and `createApp` took
 * an optional `mailer` -- but nothing ever built one, and `RESEND_API_KEY` was read by no
 * code at all. Setting the secret would have changed nothing, silently.
 *
 * It is the same shape as the bug that made the deployed server answer only `/healthz`:
 * a seam that every test supplies and the entrypoint does not.
 */
const mailer =
  config.mail === null
    ? undefined
    : createMailer({
        db,
        transport: resendTransport(config.mail.apiKey, config.mail.from),
      });

/*
  One line at boot, because "is mail on?" had no answer you could get from outside.

  It names the sender, never the key. An operator reading this in Cloud Run's logs is the
  cheapest possible check that the secret arrived and was understood.
*/
console.log(
  config.mail === null
    ? 'cypherkey: mail is off — RESEND_API_KEY is not set, so no X-3 failure notices will be sent'
    : `cypherkey: mail is on, sending as ${config.mail.from}`,
);

export default {
  port: config.port,
  fetch: createApp({ db, config, ...(mailer === undefined ? {} : { mailer }) }).fetch,
};
