import { useState } from 'react';
import type { Language } from '../../../shared/i18n';
import type { Settings } from '../../../shared/settings';
import { makeT } from './strings';

type Notifications = Settings['notifications'];
const kinds: (keyof Omit<Notifications, 'enabled'>)[] = [
  'done',
  'approval',
  'error',
  'routine',
  'rooms',
];

/**
 * Background running and notifications. Saved as soon as a box changes, like
 * the Telegram section, so the Save button stays about the form above.
 */
export function NotifySection({
  initial,
  language,
  onSaved,
  onError,
}: {
  initial: Settings;
  language: Language;
  onSaved(settings: Settings): void;
  onError(err: unknown): void;
}) {
  const t = makeT(language);
  const [background, setBackground] = useState(initial.runInBackground);
  const [notify, setNotify] = useState<Notifications>(initial.notifications);

  const save = async (patch: Partial<Pick<Settings, 'runInBackground' | 'notifications'>>) => {
    try {
      onSaved(await window.api.settings.set(patch));
    } catch (err) {
      onError(err);
    }
  };

  return (
    <fieldset className="notify">
      <legend>{t('notify.title')}</legend>
      <label className="tg-check">
        <input
          type="checkbox"
          checked={background}
          onChange={(e) => {
            setBackground(e.target.checked);
            void save({ runInBackground: e.target.checked });
          }}
        />
        <span>
          {t('notify.background')}
          <span className="field-hint notify-hint">{t('notify.backgroundHint')}</span>
        </span>
      </label>
      <label className="tg-check">
        <input
          type="checkbox"
          checked={notify.enabled}
          onChange={(e) => {
            const next = { ...notify, enabled: e.target.checked };
            setNotify(next);
            void save({ notifications: next });
          }}
        />
        <span>{t('notify.enabled')}</span>
      </label>
      <div className={`notify-kinds${notify.enabled ? '' : ' off'}`}>
        {kinds.map((kind) => (
          <label key={kind} className="tg-check">
            <input
              type="checkbox"
              disabled={!notify.enabled}
              checked={notify[kind]}
              onChange={(e) => {
                const next = { ...notify, [kind]: e.target.checked };
                setNotify(next);
                void save({ notifications: next });
              }}
            />
            <span>{t(`notify.${kind}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
