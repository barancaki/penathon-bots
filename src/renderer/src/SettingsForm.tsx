import { useState } from 'react';
import type { Settings, SettingsPatch } from '../../shared/settings';
import { translate } from '../../shared/i18n';
import type { Bot } from '../../shared/bots';
import { TelegramSection } from './ui/Telegram';
import { NotifySection } from './ui/NotifySection';

export function SettingsForm({
  initial,
  onSaved,
  onClose,
  onError,
  bots = [],
}: {
  initial: Settings;
  onSaved(settings: Settings): void;
  onClose(): void;
  onError(error: unknown): void;
  bots?: Bot[];
}) {
  const [draft, setDraft] = useState(initial);
  const [keys, setKeys] = useState({ claude: '', codex: '' });
  const [remove, setRemove] = useState({ claude: false, codex: false });
  const [saving, setSaving] = useState(false);
  const t = (key: string) => translate(initial.language, key);
  return (
    <form
      className="settings-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        const patch: SettingsPatch = {
          botsDir: draft.botsDir,
          knowledgeDir: draft.knowledgeDir || null,
          language: draft.language,
          theme: draft.theme,
          engines: {},
        };
        for (const engine of ['claude', 'codex'] as const)
          patch.engines![engine] = {
            authMode: draft.engines[engine].authMode,
            ...(remove[engine] ? { apiKey: null } : keys[engine] ? { apiKey: keys[engine] } : {}),
          };
        try {
          onSaved(await window.api.settings.set(patch));
          setKeys({ claude: '', codex: '' });
          onClose();
        } catch (error) {
          onError(error);
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        {t('settings.botsDir')}
        <input
          value={draft.botsDir}
          onChange={(e) => setDraft({ ...draft, botsDir: e.target.value })}
          required
        />
      </label>
      <label>
        {t('settings.knowledgeDir')}
        <input
          value={draft.knowledgeDir ?? ''}
          onChange={(e) => setDraft({ ...draft, knowledgeDir: e.target.value })}
        />
      </label>
      <div className="flex gap-3">
        <label>
          {t('settings.language')}
          <select
            value={draft.language}
            onChange={(e) =>
              setDraft({ ...draft, language: e.target.value as Settings['language'] })
            }
          >
            {(['tr', 'en'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`settings.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('settings.theme')}
          <select
            value={draft.theme}
            onChange={(e) => setDraft({ ...draft, theme: e.target.value as Settings['theme'] })}
          >
            {['system', 'dark', 'light'].map((value) => (
              <option key={value} value={value}>
                {t(`settings.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(['claude', 'codex'] as const).map((engine) => (
        <fieldset key={engine} className="border p-2 flex flex-col gap-2">
          <legend>{t(`engine.${engine}`)}</legend>
          <label>
            {t('auth.mode')}
            <select
              value={draft.engines[engine].authMode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  engines: {
                    ...draft.engines,
                    [engine]: { ...draft.engines[engine], authMode: e.target.value },
                  },
                })
              }
            >
              {['local-cli', 'api-key'].map((value) => (
                <option key={value} value={value}>
                  {t(`auth.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('auth.key')}
            <input
              type="password"
              autoComplete="off"
              value={keys[engine]}
              disabled={remove[engine]}
              onChange={(e) => setKeys({ ...keys, [engine]: e.target.value })}
            />
          </label>
          {draft.engines[engine].hasApiKey && (
            <label>
              <span>
                <input
                  type="checkbox"
                  checked={remove[engine]}
                  onChange={(e) => setRemove({ ...remove, [engine]: e.target.checked })}
                />{' '}
                {t('auth.remove')}
              </span>
            </label>
          )}
        </fieldset>
      ))}
      <NotifySection
        initial={initial}
        language={initial.language}
        onSaved={onSaved}
        onError={onError}
      />
      <TelegramSection language={initial.language} bots={bots} onError={onError} />
      <div className="flex gap-2">
        <button disabled={saving}>{t('settings.save')}</button>
        <button type="button" disabled={saving} onClick={onClose}>
          {t('settings.close')}
        </button>
      </div>
    </form>
  );
}
