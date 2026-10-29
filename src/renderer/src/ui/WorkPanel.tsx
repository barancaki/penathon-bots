import type { Bot } from '../../../shared/bots';
import type { EventEnvelope } from '../../../shared/events';
import { Avatar } from './Avatar';
import { AlertIcon, CheckIcon, SpinnerIcon } from './icons';
import { allSteps, lastStatus, nowDoing, touchedFiles } from './state';
import type { T } from './strings';
import { KindIcon } from './Transcript';
import { RoutinesSection } from './Routines';
import type { Language } from '../../../shared/i18n';

export function WorkPanel({
  bot,
  bots,
  events,
  t,
  language,
  onAsk,
  onOpenConversation,
  onError,
}: {
  bot: Bot;
  bots: Bot[];
  events: EventEnvelope[];
  t: T;
  language: Language;
  onAsk(text: string): void;
  onOpenConversation(botId: string, conversationId: string): void;
  onError(err: unknown): void;
}) {
  const steps = allSteps(events);
  const status = lastStatus(events) ?? 'idle';
  const doing = nowDoing(events, t);
  const files = touchedFiles(steps);
  const diffs = events.flatMap((e) => (e.event.type === 'diff' ? [e.event] : []));

  return (
    <aside className="panel" aria-label={t('panel.title')}>
      <div className="panel-head drag">
        <Avatar avatar={bot.avatar} size={22} state={status} />
        <h3>{t('panel.title')}</h3>
        <span
          className="state"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {doing ?? t(`status.${status}`)}
        </span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {!steps.length && !diffs.length ? (
          <p className="panel-empty">{t('panel.empty')}</p>
        ) : (
          <>
            <div className="panel-section">{t('panel.timeline')}</div>
            <ol className="timeline">
              {steps.map((step) => (
                <li
                  key={step.id}
                  className={`tl-item${step.running ? ' running' : ''}${step.failed ? ' failed' : ''}`}
                >
                  <span className="tl-dot">
                    {step.running ? (
                      <SpinnerIcon size={12} />
                    ) : (
                      <KindIcon kind={step.kind} size={12} />
                    )}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="tl-title">{step.title}</div>
                    {step.args && (
                      <code className="tl-args" title={step.args}>
                        {step.args}
                      </code>
                    )}
                    {step.result && <div className="tl-result">{step.result}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {files.length > 0 && (
              <>
                <div className="panel-section">{t('panel.files')}</div>
                <ul className="files">
                  {files.map((file) => (
                    <li key={file.path} title={file.path}>
                      {file.failed ? (
                        <AlertIcon size={13} />
                      ) : (
                        <CheckIcon size={13} style={{ color: 'var(--faint)' }} />
                      )}
                      <code
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {baseName(file.path)}
                      </code>
                      <span className={`tag${file.write ? ' write' : ''}`}>
                        {t(file.write ? 'panel.write' : 'panel.read')}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {diffs.length > 0 && (
              <>
                <div className="panel-section">{t('panel.changes')}</div>
                {diffs.map((diff, i) => (
                  <details key={`${diff.file}-${i}`} className="diff">
                    <summary>
                      <code>{baseName(diff.file)}</code>
                    </summary>
                    <pre>
                      {diff.unifiedDiff.split('\n').map((line, n) => (
                        <div
                          key={n}
                          className={
                            line.startsWith('+') && !line.startsWith('+++')
                              ? 'add'
                              : line.startsWith('-') && !line.startsWith('---')
                                ? 'del'
                                : undefined
                          }
                        >
                          {line || ' '}
                        </div>
                      ))}
                    </pre>
                  </details>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <RoutinesSection
        key={bot.id}
        bot={bot}
        bots={bots}
        t={t}
        language={language}
        onAsk={onAsk}
        onOpenConversation={onOpenConversation}
        onError={onError}
      />
    </aside>
  );
}

function baseName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || path;
}
