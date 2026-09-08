/**
 * The popup's screens, rendered side by side at their real width.
 *
 * A design pass cannot be checked by unit tests: they assert that a label exists, not
 * that a row is legible or that a card has room to breathe. This renders the actual
 * components against the actual built stylesheet, so what is screenshotted is what
 * Chrome shows -- no hand-written approximation of the markup, which would only ever
 * verify itself.
 *
 * Example data, never real: a preview that needed a vault would need a passphrase.
 */
import { createRoot } from 'react-dom/client';
import { Settings } from '../../extension/entrypoints/options/Settings';
import { Enroll } from '../../extension/entrypoints/popup/Enroll';
import { Feedback } from '../../extension/entrypoints/popup/Feedback';
import { Generator } from '../../extension/entrypoints/popup/Generator';
import { Import } from '../../extension/entrypoints/popup/Import';
import { ItemEdit } from '../../extension/entrypoints/popup/ItemEdit';
import { ItemView } from '../../extension/entrypoints/popup/ItemView';
import { Onboarding } from '../../extension/entrypoints/popup/Onboarding';
import { Profile } from '../../extension/entrypoints/popup/Profile';
import { RecoveryKit } from '../../extension/entrypoints/popup/RecoveryKit';
import { VaultList } from '../../extension/entrypoints/popup/VaultList';
import type { VaultItem } from '../../extension/src/vault/item';

const now = Date.now();
const day = 86_400_000;

const items: VaultItem[] = [
  {
    kind: 'login',
    id: '1',
    title: 'Linear',
    host: 'linear.app',
    username: 'm.reyes@hey.com',
    password: 'x',
    updatedAt: now - day * 40,
  },
  {
    kind: 'login',
    id: '2',
    title: 'Fastmail',
    host: 'fastmail.com',
    username: 'mara@fastmail.com',
    password: 'x',
    updatedAt: now - day * 3,
  },
  {
    kind: 'login',
    id: '3',
    title: 'GitHub',
    host: 'github.com',
    username: 'mreyes',
    password: 'correct-horse-battery',
    notes: 'Org SSO is separate.',
    updatedAt: now - day * 150,
  },
  {
    kind: 'login',
    id: '4',
    title: 'Monzo',
    host: 'monzo.com',
    username: 'm.reyes@hey.com',
    password: 'x',
    updatedAt: now - 1000,
  },
  {
    kind: 'note',
    id: '5',
    title: 'Wifi — flat',
    body: 'Router code is on the back.',
    updatedAt: now - day,
  },
];

const noop = () => {};

/*
  Stubs, not fakes with behaviour.

  These screens are being looked at, not driven: a preview that could actually sign up
  would need a server, and one that could enrol would need a passphrase typed into it.
  Each stub answers the one call its screen makes on mount and nothing else.
*/
const never = () => new Promise<never>(() => {});
const enrollSession = {
  authed: () => async () => ({
    status: 200,
    body: { required: 8, submitted: 5, remaining: 3, built: false },
  }),
  commitmentsFor: never,
} as never;

/**
 * The settings screen answers two calls on mount and is otherwise inert here.
 *
 * `prove` never resolves: the derivation is an Argon2id pass in a Worker, and a preview
 * has no session to run one in. Nothing on this screen is clicked, so it never resolves.
 */
const settingsRequest = (async (_method: string, path: string) =>
  path === '/user/devices'
    ? {
        status: 200,
        body: {
          devices: [
            {
              id: 'd1',
              name: 'ThinkPad X1',
              platform: 'linux',
              lastSeenAt: now,
              revokedAt: null,
              current: true,
            },
            {
              id: 'd2',
              name: 'Pixel 8',
              platform: 'android',
              lastSeenAt: now - day,
              revokedAt: null,
            },
            {
              id: 'd3',
              name: 'Old MacBook',
              platform: 'macos',
              lastSeenAt: now - day * 90,
              revokedAt: now - day * 60,
            },
          ],
        },
      }
    : {
        status: 200,
        body: {
          biometricEnabled: true,
          pauseUntil: null,
          thresholds: { strictness: 'medium' },
          keyVersion: 1,
        },
      }) as never;

/**
 * The options page is a tab, not a popup, so it gets its own frame.
 *
 * Not a detail: at 380x560 the preview clipped everything below Pause, which is where
 * the two controls with real consequences live -- Strictness and the device list. A
 * frame that hides half the screen reviews half the screen.
 */
const OPTIONS_FRAME: [number, number] = [620, 1180];

const FRAMES: Array<[string, React.ReactNode, [number, number]?]> = [
  [
    '01/02 · Onboarding',
    <Onboarding
      key="onboarding"
      session={{ signup: never } as never}
      consentPolicyVersion="2026-09-01"
      onComplete={noop}
      onHasAccount={noop}
    />,
  ],
  [
    '03/04 · Recovery Kit',
    <RecoveryKit
      key="kit"
      recoveryCode="K7QM2-8FTVX-4WNPD-9JRHS-3LBCG-6YZEA-5UK"
      backupCodes={['4F2K-9QXM', '7TND-1BVR', '3JLP-6ZWC', '8HGS-2YEA', '5RUK-4MDF', '9CQT-7NPX']}
      onConfirmed={noop}
    />,
  ],
  [
    '05 · Enrolment',
    <Enroll key="enrol" session={enrollSession} enrollmentToken="t" onBuilt={noop} />,
  ],
  [
    '09 · Vault',
    <VaultList
      key="vault"
      items={items}
      username="mreyes"
      onOpen={noop}
      onAdd={noop}
      onProfile={noop}
      onImport={noop}
    />,
  ],
  [
    '10 · Vault, empty',
    <VaultList
      key="vault-empty"
      items={[]}
      username="mreyes"
      onOpen={noop}
      onAdd={noop}
      onProfile={noop}
      onImport={noop}
    />,
  ],
  [
    '11 · Item detail',
    <ItemView
      key="item"
      item={items[2] as never}
      onEdit={noop}
      onBack={noop}
      browser={{} as never}
    />,
  ],
  [
    '15 · Profile',
    <Profile
      key="profile"
      username="mreyes"
      theme="light"
      onTheme={noop}
      version="0.1.0"
      openSettings={noop}
      onLock={noop}
      onSignOut={noop}
      onBack={noop}
    />,
  ],
  [
    '12 · Item edit',
    <ItemEdit key="edit" item={items[2] as never} kind="login" onSave={noop} onCancel={noop} />,
  ],
  [
    '13 · Generator',
    <div key="gen" className="ck-app" style={{ padding: 'var(--ck-s5)' }}>
      <Generator onUse={noop} />
    </div>,
  ],
  ['14 · Import', <Import key="import" onImport={noop} onCancel={noop} />],
  [
    '17 · Settings (options page)',
    <Settings
      key="settings"
      request={settingsRequest}
      accessToken="preview"
      prove={never}
      onRekeyRequested={noop}
    />,
    OPTIONS_FRAME,
  ],
  [
    '16 · Feedback',
    <div key="feedback" className="ck-app" style={{ padding: 'var(--ck-s5)' }}>
      <Feedback
        version="0.1.0"
        userAgent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
      />
    </div>,
  ],
];

/*
  Both palettes, side by side.

  A theme is not checkable one at a time: the defects are contrast failures and colours
  that only resolve on one ground, and those are invisible until the two sit next to each
  other. Each row stamps `data-theme` on its own wrapper, which is the same attribute the
  document carries at runtime, so the tokens resolve exactly as they will in the popup.
*/
const host = document.getElementById('frames');
if (host !== null) {
  for (const theme of ['light', 'dark'] as const) {
    const row = document.createElement('section');
    row.dataset.theme = theme;
    row.style.cssText = 'display:flex;gap:24px;flex-wrap:wrap;padding:24px;border-radius:12px';
    row.style.background = theme === 'light' ? '#dfe3f2' : '#0b0d16';

    const heading = document.createElement('h2');
    heading.textContent = theme === 'light' ? 'Light — the default' : 'Dark';
    heading.style.cssText = `width:100%;margin:0;font:500 13px ui-sans-serif,system-ui;color:${
      theme === 'light' ? '#595d6c' : '#9397ab'
    }`;
    row.append(heading);

    for (const [label, node, frame] of FRAMES) {
      const figure = document.createElement('figure');
      figure.style.cssText = 'margin:0;display:flex;flex-direction:column;gap:8px';

      const caption = document.createElement('figcaption');
      caption.textContent = label;
      caption.style.cssText = `font:500 12px ui-sans-serif,system-ui;color:${
        theme === 'light' ? '#595d6c' : '#9397ab'
      }`;

      // The popup's real size, unless the screen has one of its own. The height is
      // where a popup would start scrolling.
      const [width, height] = frame ?? [380, 560];
      const box = document.createElement('div');
      box.style.cssText = 'overflow:hidden;border-radius:8px;background:var(--ck-bg)';
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      box.style.border = `1px solid ${theme === 'light' ? '#cfd3e5' : '#3f424d'}`;

      figure.append(caption, box);
      row.append(figure);
      createRoot(box).render(node);
    }
    host.append(row);
  }
}
