/**
 * The "not your rhythm" email.
 *
 * X-3 calls this a feature rather than a notification, and it is: the dark-web-breach
 * email inverted. Instead of "your password appeared in a dump, change it", it says
 * "someone had your password and it did not work". That is the clearest evidence a user
 * ever gets that the product did its job.
 *
 * What it must not contain is as considered as what it does. No score, no feature
 * vector, no device name, no IP, no precise time. A mailbox is not a trusted place: it
 * is read on phones, forwarded, backed up unencrypted, and is often the very account an
 * attacker compromises first. Anything in here is something an attacker who reads the
 * mail learns about how the rhythm check behaves — and a score in particular tells them
 * how close they got, which is a hill-climbing signal.
 */

export type FailureNotice = {
  /** Coarse only: a country, or nothing. Never a city, an IP, or a device name. */
  approximateLocation?: string;
};

export const SUBJECT = 'Someone tried your CypherKey passphrase';

export function renderFailureNotice(notice: FailureNotice = {}): { subject: string; text: string } {
  const where =
    notice.approximateLocation === undefined || notice.approximateLocation.length === 0
      ? 'somewhere'
      : `in ${notice.approximateLocation}`;

  const text = [
    'Someone typed your CypherKey passphrase correctly, and was refused.',
    '',
    `The attempt came from ${where}. Your typing rhythm did not match, so nothing was`,
    'unlocked and your vault was not opened.',
    '',
    'This is what CypherKey is for. A stolen passphrase on its own is not enough.',
    '',
    'You do not need to do anything. If this was you — a new keyboard, an injury, a bad',
    'day — just try again; the unlock screen will offer a second attempt and a Backup',
    'Code if you need one.',
    '',
    'If it was not you, your passphrase is known to someone else. Change it from',
    'Settings, and change it anywhere else you have used it.',
    '',
    '— CypherKey',
  ].join('\n');

  return { subject: SUBJECT, text };
}
