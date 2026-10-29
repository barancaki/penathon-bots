import { expect, it } from 'vitest';
import { translate } from '../src/shared/i18n';

it.each(['en', 'tr'] as const)(
  'translates model-boundary permission and hook errors in %s',
  (language) => {
    for (const key of [
      'errors.deletionDenied',
      'errors.indirectDeletion',
      'errors.toolScopeDenied',
      'errors.connectorDenied',
      'errors.approvalNotEditable',
      'errors.approvalProcessing',
      'errors.approvalMissing',
      'errors.networkCeiling',
      'errors.connectionCeiling',
    ]) {
      expect(translate(language, key)).not.toBe(key);
      if (language === 'en') expect(translate(language, key)).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/);
    }
  },
);

it('interpolates names and counts without changing literal replacement characters', () => {
  expect(translate('en', 'approval.createBot', { name: 'Writer $& {name}' })).toBe(
    'Create bot: Writer $& {name}',
  );
  expect(translate('tr', 'desktop.approvals', { count: 3 })).toBe('3 onay bekliyor');
});

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

it.each(['en', 'tr'] as const)(
  'translates built-in routine notices and status summaries in %s',
  (language) => {
    for (const key of [
      'routines.reportProcessing',
      'routines.reportPrompt',
      'routines.processOneReport',
      'notice.incompatibleRoutineModel',
      'errors.appClosed',
      'errors.runCancelled',
      'errors.botBusy',
    ]) {
      const text = translate(language, key);
      expect(text).not.toBe(key);
      if (language === 'en') expect(text).not.toMatch(/[ğüşıöçĞÜŞİÖÇ]/);
    }
  },
);

it('treats Object.prototype names as plain text, not dictionary entries', () => {
  expect(translate('en', 'constructor')).toBe('constructor');
  expect(translate('tr', 'Read {constructor}')).toBe('Read {constructor}');
  expect(translate('en', 'toString')).toBe('toString');
});
