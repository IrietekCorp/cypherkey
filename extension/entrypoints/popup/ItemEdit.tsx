import { useRef, useState } from 'react';
import { type VaultItem, newItemId } from '../../src/vault/item';
import { Generator } from './Generator';

export type ItemEditProps = {
  /** Absent when adding. */
  item?: VaultItem;
  kind: VaultItem['kind'];
  now?: () => number;
  onSave(item: VaultItem): void;
  onCancel(): void;
};

/**
 * Add or edit one item.
 *
 * Fields are uncontrolled, as in M2-03: React's `onChange` does not fire under
 * happy-dom, and these have no formatting or as-you-type validation, so controlled
 * state would cost re-renders while typing and buy nothing.
 */
export function ItemEdit({ item, kind, now = Date.now, onSave, onCancel }: ItemEditProps) {
  const title = useRef<HTMLInputElement>(null);
  const host = useRef<HTMLInputElement>(null);
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);

  const effectiveKind = item?.kind ?? kind;
  const value = (ref: { current: { value: string } | null }) => ref.current?.value.trim() ?? '';

  const save = () => {
    const found: string[] = [];
    const titleValue = value(title);
    if (titleValue.length === 0) found.push('Give it a title.');

    if (effectiveKind === 'login') {
      if (value(host).length === 0) found.push('Enter the site this belongs to.');
      if ((password.current?.value ?? '').length === 0) found.push('Enter a password.');
    } else if ((body.current?.value ?? '').length === 0) {
      found.push('Write something in the note.');
    }

    if (found.length > 0) {
      setProblems(found);
      return;
    }

    const id = item?.id ?? newItemId();
    onSave(
      effectiveKind === 'login'
        ? {
            kind: 'login',
            id,
            title: titleValue,
            host: value(host),
            username: value(username),
            // Not trimmed: leading or trailing spaces are legitimate in a password and
            // silently removing them would lock the user out of the site.
            password: password.current?.value ?? '',
            ...(value(notes).length > 0 ? { notes: value(notes) } : {}),
            updatedAt: now(),
          }
        : {
            kind: 'note',
            id,
            title: titleValue,
            body: body.current?.value ?? '',
            updatedAt: now(),
          },
    );
  };

  return (
    <main className="ck-app flex flex-col" style={{ padding: 'var(--ck-s5)', gap: 'var(--ck-s4)' }}>
      {/* Frame 12. */}
      <h1 className="ck-h1">
        {item === undefined ? 'New' : 'Edit'} {effectiveKind === 'login' ? 'login' : 'note'}
      </h1>

      <Labelled label="Title" htmlFor="field-title">
        <input
          ref={title}
          id="field-title"
          data-testid="title"
          defaultValue={item?.title ?? ''}
          className="input"
        />
      </Labelled>

      {effectiveKind === 'login' ? (
        <>
          <Labelled label="Site" htmlFor="field-host">
            <input
              ref={host}
              id="field-host"
              data-testid="host"
              defaultValue={item?.kind === 'login' ? item.host : ''}
              placeholder="example.com"
              className="input"
            />
          </Labelled>
          <Labelled label="Username" htmlFor="field-username">
            <input
              ref={username}
              id="field-username"
              data-testid="username"
              defaultValue={item?.kind === 'login' ? item.username : ''}
              className="input"
            />
          </Labelled>
          <Labelled label="Password" htmlFor="field-password">
            <input
              ref={password}
              type="password"
              id="field-password"
              data-testid="password"
              defaultValue={item?.kind === 'login' ? item.password : ''}
              className="input font-mono"
            />
          </Labelled>
          {/*
            One click from the field it fills. A generator behind a separate screen is
            one people stop using, and a password they invent instead is the whole
            problem this exists to solve.
          */}
          <button
            type="button"
            data-testid="toggle-generator"
            onClick={() => setGenerating((g) => !g)}
            className="btn btn-ghost ck-small self-start"
          >
            {generating ? 'Hide generator' : 'Generate a password'}
          </button>
          {generating && (
            <Generator
              onUse={(generated) => {
                if (password.current !== null) password.current.value = generated;
                setGenerating(false);
              }}
            />
          )}

          <Labelled label="Notes" htmlFor="field-notes">
            <textarea
              ref={notes}
              id="field-notes"
              data-testid="notes"
              defaultValue={item?.kind === 'login' ? (item.notes ?? '') : ''}
              className="input"
            />
          </Labelled>
        </>
      ) : (
        <Labelled label="Note" htmlFor="field-body">
          <textarea
            ref={body}
            id="field-body"
            data-testid="body"
            defaultValue={item?.kind === 'note' ? item.body : ''}
            rows={6}
            className="input"
          />
        </Labelled>
      )}

      {problems.length > 0 && (
        <ul
          data-testid="problems"
          className="ck-small flex flex-col"
          style={{ gap: 'var(--ck-s1)', color: 'var(--ck-fail-text)' }}
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex" style={{ gap: 'var(--ck-s2)' }}>
        <button
          type="button"
          data-testid="save"
          onClick={save}
          className="btn btn-primary"
          style={{ flex: 1 }}
        >
          Save
        </button>
        <button type="button" data-testid="cancel" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </main>
  );
}

/**
 * Explicit `htmlFor`/`id` rather than wrapping. A screen reader announces the label
 * when focus reaches the control either way, but the explicit association also survives
 * the field being moved, and is what static analysis can actually verify.
 */
function Labelled({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
