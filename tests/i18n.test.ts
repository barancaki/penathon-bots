import { expect, it } from 'vitest';
import { translate } from '../src/shared/i18n';

it('translates connector warmup in Turkish and English', () => {
  expect(translate('tr', 'notice.connectorsWarming')).toBe('Bağlantılar hazırlanıyor…');
  expect(translate('en', 'notice.connectorsWarming')).toBe('Preparing connections…');
});

it.each(['claude', 'codex'] as const)(
  'provides actionable Turkish and English login errors for %s',
  (engine) => {
    const key = `errors.${engine}Auth`;
    for (const language of ['tr', 'en'] as const) {
      const text = translate(language, key);
      expect(text).not.toBe(key);
      expect(text).toContain(engine === 'claude' ? '/login' : 'codex login');
    }
    expect(translate('tr', key)).toContain(
      engine === 'claude' ? 'Claude girişi gerekli' : 'Codex girişi gerekli',
    );
    expect(translate('en', key)).toContain('login required');
  },
);
it('translates pairing lockout in Turkish and English', () => {
  expect(translate('tr', 'telegram.pairingLocked')).toBe(
    'Çok fazla yanlış deneme; yeni bir eşleştirme kodu al.',
  );
  expect(translate('en', 'telegram.pairingLocked')).toContain('new pairing code');
});

it.each(['tr', 'en'] as const)(
  'translates the removed knowledge paths notice in %s',
  (language) => {
    const key = 'notice.knowledgePathsRemoved';
    expect(translate(language, key)).not.toBe(key);
  },
);
