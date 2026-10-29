import { useEffect, useRef, useState } from 'react';
import type { Bot } from '../../../shared/bots';
import type { Language } from '../../../shared/i18n';
import type { RoutineRun, RoutineState, Schedule, WorkReport } from '../../../shared/routines';
import { routineName, routinePrompt } from '../../../shared/routines';
import { Avatar } from './Avatar';
import { AlertIcon, CheckIcon, ChevronIcon, ClockIcon, SendIcon, SpinnerIcon } from './icons';
import { formatDuration, shorten } from './state';
import type { T } from './strings';

/**
 * The bot's routines, under the live work view. Routines are made by talking:
 * the instruction box sends the request to the bot, which proposes the
 * routine on an approval card. Each routine opens to its past runs.
 */
export function RoutinesSection({
  bot,
  bots,
  t,
  language,
  onAsk,
  onOpenConversation,
  onError,
}: {
  bot: Bot;
  bots: Bot[];
  t: T;
  language: Language;
  onAsk(text: string): void;
  onOpenConversation(botId: string, conversationId: string): void;
  onError(err: unknown): void;
}) {
  const [routines, setRoutines] = useState<RoutineState[]>();
  const [open, setOpen] = useState<string>();
  const [draft, setDraft] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      void window.api.routines
        .list(bot.id)
        .then((r) => live && setRoutines(r))
        .catch(() => live && setRoutines([]));
    load();
    const off = window.api.routines.onChanged((botId) => botId === bot.id && load());
    return () => {
      live = false;
      off();
    };
  }, [bot.id]);

  const ask = () => {
    const text = draft.trim();
    if (!text) return;
    onAsk(t('routines.askPrefix', { text }));
    setDraft('');
  };

  const toggle = async (state: RoutineState) => {
    const { id: _id, system: _system, ...rest } = state.routine;
    void _id;
    void _system;
    try {
      await window.api.routines.save(bot.id, {
        ...rest,
        id: state.routine.id,
        enabled: !state.routine.enabled,
      });
    } catch (err) {
      onError(err);
    }
  };

  return (
    <section className="routines" aria-label={t('routines.title')}>
      <div className="panel-section routines-head">
        <span>{t('routines.title')}</span>
        <button
          type="button"
          className="link"
          onClick={() => box.current?.focus()}
          title={t('routines.newHint')}
        >
          + {t('routines.new')}
        </button>
      </div>
      <div className="routines-body scroll">
        {!routines && <p className="meta routines-empty">{t('editor.loading')}</p>}
        {routines?.length === 0 && <p className="routines-empty">{t('routines.empty')}</p>}
        <ul className="routine-list">
          {routines?.map((state) => (
            <RoutineRow
              key={state.routine.id}
              state={state}
              open={open === state.routine.id}
              t={t}
              language={language}
              onToggleOpen={() => setOpen(open === state.routine.id ? undefined : state.routine.id)}
              onToggleEnabled={() => void toggle(state)}
              onOpenConversation={(cid) => onOpenConversation(bot.id, cid)}
              onError={onError}
            />
          ))}
        </ul>
        {bot.system && (
          <ReportsSection
            bots={bots}
            t={t}
            language={language}
            onOpenConversation={onOpenConversation}
            onError={onError}
          />
        )}
      </div>
      <form
        className="routine-ask"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <textarea
          ref={box}
          rows={2}
          value={draft}
          placeholder={t('routines.askPlaceholder')}
          aria-label={t('routines.new')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              ask();
            }
          }}
        />
        <button
          type="submit"
          className="icon-btn"
          disabled={!draft.trim()}
          aria-label={t('chat.send')}
        >
          <SendIcon size={15} />
        </button>
      </form>
    </section>
  );
}

function RoutineRow({
  state,
  open,
  t,
  language,
  onToggleOpen,
  onToggleEnabled,
  onOpenConversation,
  onError,
}: {
  state: RoutineState;
  open: boolean;
  t: T;
  language: Language;
  onToggleOpen(): void;
  onToggleEnabled(): void;
  onOpenConversation(conversationId: string): void;
  onError(err: unknown): void;
}) {
  const { routine, lastRun, nextRunAt } = state;
  const [runs, setRuns] = useState<RoutineRun[]>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void window.api.routines
      .runs(state.botId, routine.id, 20)
      .then((r) => live && setRuns(r))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [open, state.botId, routine.id, lastRun?.id, lastRun?.status]);

  const runNow = async () => {
    setStarting(true);
    try {
      const { conversationId } = await window.api.routines.runNow(state.botId, routine.id);
      onOpenConversation(conversationId);
    } catch (err) {
      onError(err);
    } finally {
      setStarting(false);
    }
  };

  return (
    <li className={`routine${routine.enabled ? '' : ' paused'}${open ? ' open' : ''}`}>
      <div className="routine-row">
        <button type="button" className="routine-main" onClick={onToggleOpen} aria-expanded={open}>
          <RunDot run={lastRun} />
          <span className="routine-text">
            <span className="routine-name">{t(routineName(routine, state.botId))}</span>
            <span className="routine-when">
              {scheduleText(routine.schedule, t)}
              {routine.enabled && nextRunAt
                ? ` · ${t('routines.next', { when: relative(nextRunAt, language) })}`
                : !routine.enabled
                  ? ` · ${t('routines.paused')}`
                  : ''}
            </span>
          </span>
          <ChevronIcon size={13} className="chev" />
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={routine.enabled}
          className="switch"
          title={routine.enabled ? t('routines.pause') : t('routines.resume')}
          aria-label={routine.enabled ? t('routines.pause') : t('routines.resume')}
          onClick={onToggleEnabled}
        >
          <span />
        </button>
      </div>
      {open && (
        <div className="routine-detail">
          <p className="routine-prompt">{shorten(t(routinePrompt(routine, state.botId)), 220)}</p>
          <div className="routine-actions">
            <button type="button" className="btn" disabled={starting} onClick={() => void runNow()}>
              {t('routines.runNow')}
            </button>
            {routine.model && <span className="meta">{routine.model}</span>}
          </div>
          <div className="field-label">{t('routines.history')}</div>
          {!runs && <p className="meta">{t('editor.loading')}</p>}
          {runs?.length === 0 && <p className="meta">{t('routines.noRuns')}</p>}
          <ol className="run-list">
            {runs?.map((run) => (
              <li key={run.id}>
                <RunDot run={run} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="run-head">
                    <span>{when(run.startedAt, language)}</span>
                    {run.durationMs !== undefined && (
                      <span className="meta">{formatDuration(run.durationMs, language)}</span>
                    )}
                    <span className={`run-status s-${run.status}`}>
                      {t(`routines.status.${run.status}`)}
                    </span>
                  </div>
                  {run.summary && <p className="run-summary">{shorten(t(run.summary), 160)}</p>}
                </div>
                {run.status !== 'skipped' && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpenConversation(run.conversationId)}
                  >
                    {t('routines.openRun')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

function ReportsSection({
  bots,
  t,
  language,
  onOpenConversation,
  onError,
}: {
  bots: Bot[];
  t: T;
  language: Language;
  onOpenConversation(botId: string, conversationId: string): void;
  onError(err: unknown): void;
}) {
  const [reports, setReports] = useState<WorkReport[]>();
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () =>
      void window.api.reports
        .list({ pending: true, limit: 30 })
        .then((r) => live && setReports(r))
        .catch(() => live && setReports([]));
    load();
    const off = window.api.reports.onChanged(load);
    return () => {
      live = false;
      off();
    };
  }, []);

  if (!reports?.length) return null;
  const chief = bots.find((b) => b.system);
  return (
    <div className="reports">
      <div className="field-label">{t('reports.title', { n: reports.length })}</div>
      <ul className="report-list">
        {reports.map((r) => {
          const from = bots.find((b) => b.id === r.botId);
          return (
            <li key={r.id} style={from ? { ['--bot' as string]: from.avatar.color } : undefined}>
              {from && <Avatar avatar={from.avatar} size={22} />}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="run-head">
                  <span className="report-from">{from?.name ?? r.botId}</span>
                  <span className="meta">{when(r.createdAt, language)}</span>
                </div>
                <p className="run-summary">{shorten(r.summary, 140)}</p>
              </div>
              <button
                type="button"
                className="link"
                disabled={busy === r.id}
                onClick={async () => {
                  setBusy(r.id);
                  try {
                    const { conversationId } = await window.api.reports.processNow(r.id);
                    if (chief) onOpenConversation(chief.id, conversationId);
                  } catch (err) {
                    onError(err);
                  } finally {
                    setBusy(undefined);
                  }
                }}
              >
                {t('reports.processNow')}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RunDot({ run }: { run?: RoutineRun }) {
  if (!run) return <ClockIcon size={14} className="run-dot idle" />;
  if (run.status === 'running') return <SpinnerIcon size={14} className="run-dot running" />;
  if (run.status === 'done') return <CheckIcon size={14} className="run-dot done" />;
  if (run.status === 'error') return <AlertIcon size={14} className="run-dot error" />;
  return <ClockIcon size={14} className="run-dot idle" />;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function scheduleText(s: Schedule, t: T): string {
  if (s.kind === 'daily') return t('schedule.daily', { time: s.time });
  if (s.kind === 'interval') {
    const every =
      s.everyMinutes % 60 === 0
        ? t('schedule.everyHours', { n: s.everyMinutes / 60 })
        : t('schedule.everyMinutes', { n: s.everyMinutes });
    return s.from && s.to ? `${every}, ${s.from}–${s.to}` : every;
  }
  const days = [...s.days].sort();
  const key = days.join(',');
  const label =
    key === '1,2,3,4,5'
      ? t('schedule.weekdays')
      : key === '0,6'
        ? t('schedule.weekend')
        : days.map((d) => t(`schedule.day.${d}`)).join(', ');
  return t('schedule.weekly', { days: label, time: s.time });
}

function when(iso: string, language: Language) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay
    ? time
    : `${d.toLocaleDateString(language, { day: 'numeric', month: 'short' })} ${time}`;
}

function relative(iso: string, language: Language) {
  const diff = new Date(iso).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}
