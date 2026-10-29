import { useEffect, useState } from 'react';
import type { Bot } from '../../../shared/bots';
import type { Language } from '../../../shared/i18n';
import type { TelegramStatus } from '../../../shared/telegram';
import { Avatar } from './Avatar';
import { Menu } from './Menu';
import { makeT } from './strings';

/**
 * Telegram bridge settings. The token is stored encrypted and never shown
 * again; pairing is a six-digit code the user sends to the bot, so only their
 * own private chat is ever answered.
 */
export function TelegramSection({
  language,
  bots,
  onError,
}: {
  language: Language;
  bots: Bot[];
  onError(err: unknown): void;
}) {
  const t = makeT(language);
  const [status, setStatus] = useState<TelegramStatus>();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void window.api.telegram
      .status()
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    const off = window.api.telegram.onStatus((s) => live && setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);

  const run = async (action: () => Promise<TelegramStatus>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const route = bots.find((b) => b.id === status.routeTo) ?? bots.find((b) => b.system);

  return (
    <fieldset className="telegram">
      <legend>Telegram</legend>
      <p className="editor-hint">{t('telegram.hint')}</p>

      {!status.configured ? (
        <div className="tg-step">
          <span className="tg-num">1</span>
          <div className="tg-body">
            <span>{t('telegram.tokenStep')}</span>
            <div className="tg-row">
              <input
                type="password"
                autoComplete="off"
                value={token}
                placeholder="123456:ABC…"
                aria-label={t('telegram.token')}
                onChange={(e) => setToken(e.target.value)}
              />
              <button
                type="button"
                disabled={busy || !token.trim()}
                onClick={() =>
                  void run(async () => {
                    const s = await window.api.telegram.setToken(token.trim());
                    setToken('');
                    return s;
                  })
                }
              >
                {t('telegram.connect')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="tg-status">
          <span className={`tg-dot${status.running ? ' on' : ''}`} />
          <span>
            {status.botUsername ? `@${status.botUsername}` : t('telegram.configured')}
            {' · '}
            {status.running ? t('telegram.running') : t('telegram.stopped')}
          </span>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => void run(() => window.api.telegram.setToken(null))}
          >
            {t('telegram.removeToken')}
          </button>
        </div>
      )}

      {status.lastError && (
        <p className="tg-error" role="alert">
          {t(status.lastError)}
        </p>
      )}

      {status.configured &&
        (status.pairedChat ? (
          <div className="tg-status">
            <span className="tg-dot on" />
            <span>{t('telegram.paired', { name: status.pairedChat.name })}</span>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void run(() => window.api.telegram.unpair())}
            >
              {t('telegram.unpair')}
            </button>
          </div>
        ) : (
          <div className="tg-step">
            <span className="tg-num">2</span>
            <div className="tg-body">
              {status.pairingCode ? (
                <>
                  <span>
                    {t('telegram.sendCode', {
                      bot: status.botUsername ? `@${status.botUsername}` : 'bot',
                    })}
                  </span>
                  <code className="tg-code">/start {status.pairingCode}</code>
                  <span className="meta">{t('telegram.codeExpires')}</span>
                </>
              ) : (
                <>
                  <span>{t('telegram.pairStep')}</span>
                  <div className="tg-row">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => window.api.telegram.startPairing())}
                    >
                      {t('telegram.pair')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}

      {status.configured && status.pairedChat && (
        <div className="tg-options">
          <div className="tg-option">
            <span>{t('telegram.routeTo')}</span>
            <Menu
              label={t('telegram.routeTo')}
              value={route?.id ?? ''}
              className="pill pill-field"
              options={bots
                .filter((b) => !b.temporary)
                .map((b) => ({ value: b.id, label: b.name }))}
              onChange={(routeTo) => void run(() => window.api.telegram.setOptions({ routeTo }))}
              trigger={
                route ? (
                  <span className="tg-route">
                    <Avatar avatar={route.avatar} size={18} />
                    {route.name}
                  </span>
                ) : undefined
              }
            />
          </div>
          <label className="tg-check">
            <input
              type="checkbox"
              checked={status.notifyRoutines}
              onChange={(e) =>
                void run(() => window.api.telegram.setOptions({ notifyRoutines: e.target.checked }))
              }
            />
            <span>{t('telegram.notifyRoutines')}</span>
          </label>
          <p className="meta">{t('telegram.commands')}</p>
        </div>
      )}
    </fieldset>
  );
}
