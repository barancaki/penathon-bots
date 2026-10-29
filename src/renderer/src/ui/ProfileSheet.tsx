import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/settings';
import { CloseIcon, UserIcon } from './icons';
import type { T } from './strings';

/** Who the user is, shared by every bot. Two fields on purpose: name and how to be addressed. */
export function ProfileSheet({
  profile,
  t,
  onClose,
  onSave,
}: {
  profile: Settings['profile'];
  t: T;
  onClose(): void;
  onSave(profile: Settings['profile']): void | Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const [address, setAddress] = useState(profile.address);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="sheet profile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('profile.title')}
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ name: name.trim(), address: address.trim() });
        }}
      >
        <div className="sheet-head">
          <span className="profile-mark">
            <UserIcon size={18} />
          </span>
          <h2>{t('profile.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: 'auto' }}
            aria-label={t('settings.close')}
            onClick={onClose}
          >
            <CloseIcon size={17} />
          </button>
        </div>
        <div className="editor-body">
          <p className="editor-hint">{t('profile.hint')}</p>
          <label className="field">
            <span className="field-label">{t('profile.name')}</span>
            <input
              value={name}
              maxLength={100}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('profile.address')}</span>
            <input
              value={address}
              maxLength={100}
              placeholder={t('profile.addressPlaceholder')}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
        </div>
        <div className="editor-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('editor.cancel')}
          </button>
          <button type="submit" className="btn btn-primary">
            {t('editor.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
