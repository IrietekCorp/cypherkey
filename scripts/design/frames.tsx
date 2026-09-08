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
import { ItemView } from '../../extension/entrypoints/popup/ItemView';
import { Profile } from '../../extension/entrypoints/popup/Profile';
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

const FRAMES: Array<[string, React.ReactNode]> = [
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
      version="0.1.0"
      openSettings={noop}
      onLock={noop}
      onSignOut={noop}
      onBack={noop}
    />,
  ],
];

const host = document.getElementById('frames');
if (host !== null) {
  for (const [label, node] of FRAMES) {
    const figure = document.createElement('figure');
    figure.style.cssText = 'margin:0;display:flex;flex-direction:column;gap:8px';

    const caption = document.createElement('figcaption');
    caption.textContent = label;
    caption.style.cssText = 'font:500 12px ui-sans-serif,system-ui;color:#9397ab';

    // The popup's real width, and a height that shows where a screen would scroll.
    const box = document.createElement('div');
    box.style.cssText =
      'width:380px;height:560px;overflow:hidden;border:1px solid #3f424d;border-radius:8px;background:#161826';

    figure.append(caption, box);
    host.append(figure);
    createRoot(box).render(node);
  }
}
