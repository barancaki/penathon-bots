import { createContext, useContext, useState, type ReactNode } from 'react';
import { botSchema, type Bot, type BotPatch } from '../../../shared/bots';
import type { BotEvent } from '../../../shared/events';
import { Avatar } from './Avatar';
import { connectionLabel } from './BotEditor';
import type { AccessLevel, Project, ProjectGrant } from '../../../shared/projects';
import {
  BranchIcon,
  ClockIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  MemoryIcon,
  SparkIcon,
  TrashIcon,
} from './icons';
import { LevelChip } from './ProjectsSheet';
import { scheduleText } from './Routines';
import { routineName, routinePrompt, type Routine } from '../../../shared/routines';
import { Markdown } from './Markdown';
import type { ApprovalResolution } from './state';
import type { T } from './strings';

export type CardActions = {
  bots: Bot[];
  projects: Project[];
  respond(approvalId: string, decision: 'approved' | 'rejected'): Promise<void>;
  editDraft(approvalId: string, bot: Bot): void;
  openBot(id: string): void;
};
export const CardActionsContext = createContext<CardActions | undefined>(undefined);

type Approval = Extract<BotEvent, { type: 'approval.request' }>;
type Card = Extract<BotEvent, { type: 'card' }>;

export function ApprovalCard({
  event,
  resolution,
  t,
}: {
  event: Approval;
  resolution?: ApprovalResolution;
  t: T;
}) {
  const actions = useContext(CardActionsContext);
  const [pending, setPending] = useState<'approved' | 'rejected'>();
  const answer = async (decision: 'approved' | 'rejected') => {
    if (!actions || pending) return;
    setPending(decision);
    try {
      await actions.respond(event.approvalId, decision);
    } catch {
      setPending(undefined);
    }
  };
  const open = !resolution;
  const footer = (primary: string, edit?: () => void) =>
    open ? (
      <div className="actions">
        <button
          className="btn btn-primary"
          disabled={!!pending}
          onClick={() => void answer('approved')}
        >
          {primary}
        </button>
        {edit && (
          <button className="btn" disabled={!!pending} onClick={edit}>
            {t('card.edit')}
          </button>
        )}
        <button
          className="btn btn-quiet"
          disabled={!!pending}
          onClick={() => void answer('rejected')}
        >
          {t('card.reject')}
        </button>
      </div>
    ) : (
      <Resolved resolution={resolution} t={t} />
    );

  if (event.kind === 'bot.create') {
    const parsed = botSchema.safeParse(event.data?.bot);
    if (parsed.success) {
      const bot = parsed.data;
      const parent = actions?.bots.find((b) => b.id === bot.parent);
      return (
        <div
          className={`card bot-card${open ? '' : ' settled'}`}
          style={{ ['--bot' as string]: bot.avatar.color }}
        >
          <div className="card-kicker">
            <SparkIcon size={13} />
            {bot.temporary ? t('card.newTempBot') : t('card.newBot')}
          </div>
          <div className="bot-card-id">
            <Avatar avatar={bot.avatar} size={52} state="idle" />
            <div style={{ minWidth: 0 }}>
              <h4>{bot.name}</h4>
              {bot.role && <p className="bot-card-role">{bot.role}</p>}
            </div>
          </div>
          <dl className="facts">
            <Fact label={t('card.engine')}>
              {t(`engine.${bot.engine}`)} ·{' '}
              {bot.model === 'default' ? t('composer.defaultModel') : bot.model} ·{' '}
              {t(`effort.${bot.effort}`)}
            </Fact>
            <Fact label={t('card.access')}>
              {t(`editor.sandbox.${bot.sandbox}`)} ·{' '}
              <span className="mono">{lastSegment(bot.workdir)}</span>
              {bot.writeScope.length > 1 && ` +${bot.writeScope.length - 1}`}
            </Fact>
            <Fact label={t('card.connections')}>
              {bot.connections.includes('*')
                ? t('editor.connectionsAll')
                : bot.connections.length
                  ? bot.connections.map(connectionLabel).join(', ')
                  : t('card.none')}
            </Fact>
            <Fact label={t('card.network')}>{bot.network ? t('card.yes') : t('card.no')}</Fact>
            {personaLine(bot, t) && <Fact label={t('card.voice')}>{personaLine(bot, t)}</Fact>}
            <Fact label={t('field.projects')}>
              {grantsLine(bot.projects, actions?.projects ?? [], t) || t('card.none')}
            </Fact>
            {parent && <Fact label={t('card.parent')}>{parent.name}</Fact>}
          </dl>
          {bot.instructions && (
            <details className="card-more">
              <summary>{t('card.instructions')}</summary>
              <Markdown text={bot.instructions} />
            </details>
          )}
          {footer(
            t('card.create'),
            actions ? () => actions.editDraft(event.approvalId, bot) : undefined,
          )}
        </div>
      );
    }
  }

  if (event.kind === 'bot.update') {
    const data = event.data as { botId?: string; before?: BotPatch; after?: BotPatch } | undefined;
    const target = actions?.bots.find((b) => b.id === data?.botId);
    const keys = Object.keys(data?.after ?? {}) as (keyof BotPatch)[];
    const color = (data?.after?.avatar ?? target?.avatar)?.color;
    return (
      <div
        className={`card bot-card${open ? '' : ' settled'}`}
        style={color ? { ['--bot' as string]: color } : undefined}
      >
        <div className="card-kicker">
          <SparkIcon size={13} />
          {t('card.updateBot')}
        </div>
        {target && (
          <div className="bot-card-id compact">
            <Avatar avatar={data?.after?.avatar ?? target.avatar} size={36} state="idle" />
            <h4>{data?.after?.name ?? target.name}</h4>
          </div>
        )}
        <ul className="changes">
          {keys.map((key) => (
            <li key={key}>
              <span className="change-key">{t(`field.${key}`)}</span>
              {key === 'avatar' ? (
                <span className="change-val">
                  {data?.before?.avatar && <Avatar avatar={data.before.avatar} size={22} />}
                  <span className="arrow">→</span>
                  <Avatar avatar={data!.after!.avatar!} size={22} />
                </span>
              ) : (
                <span className="change-val">
                  {data?.before?.[key] !== undefined && (
                    <span className="before">
                      {show(data.before[key], key, t, actions?.projects)}
                    </span>
                  )}
                  <span className="arrow">→</span>
                  <span className="after">
                    {show(data?.after?.[key], key, t, actions?.projects)}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
        {footer(t('card.apply'))}
      </div>
    );
  }

  if (event.kind === 'file.delete') {
    const data = event.data as { command?: string; paths?: string[] } | undefined;
    return (
      <div className={`card delete-card${open ? '' : ' settled'}`}>
        <div className="card-kicker danger">
          <TrashIcon size={13} />
          {t('card.deleteKicker')}
        </div>
        {data?.paths && data.paths.length > 0 ? (
          <ul className="path-list">
            {data.paths.slice(0, 12).map((p) => (
              <li key={p} className="mono" title={p}>
                {p}
              </li>
            ))}
            {data.paths.length > 12 && (
              <li className="meta">{t('card.morePaths', { n: data.paths.length - 12 })}</li>
            )}
          </ul>
        ) : (
          <p className="editor-hint">{t('card.deleteUnknown')}</p>
        )}
        {data?.command && <pre className="command mono">{data.command}</pre>}
        {open ? (
          <div className="actions">
            <button
              className="btn btn-danger"
              disabled={!!pending}
              onClick={() => void answer('approved')}
            >
              {t('card.deleteApprove')}
            </button>
            <button
              className="btn btn-quiet"
              disabled={!!pending}
              onClick={() => void answer('rejected')}
            >
              {t('card.deleteReject')}
            </button>
          </div>
        ) : (
          <Resolved resolution={resolution} t={t} />
        )}
      </div>
    );
  }

  if (event.kind === 'routine.create' || event.kind === 'routine.update') {
    const data = event.data as
      { botId?: string; routine?: Routine; before?: Partial<Routine> } | undefined;
    const target = actions?.bots.find((b) => b.id === data?.botId);
    const routine = data?.routine;
    return (
      <div
        className={`card bot-card${open ? '' : ' settled'}`}
        style={target ? { ['--bot' as string]: target.avatar.color } : undefined}
      >
        <div className="card-kicker">
          <ClockIcon size={13} />
          {event.kind === 'routine.create' ? t('card.newRoutine') : t('card.updateRoutine')}
        </div>
        {routine ? (
          <>
            <h4 className="routine-card-name">{t(routineName(routine, data?.botId ?? ''))}</h4>
            <dl className="facts">
              <Fact label={t('card.when')}>
                {data?.before?.schedule && (
                  <>
                    <span className="before-inline">{scheduleText(data.before.schedule, t)}</span>
                    {' → '}
                  </>
                )}
                {scheduleText(routine.schedule, t)}
              </Fact>
              {target && <Fact label={t('card.bot')}>{target.name}</Fact>}
              {routine.model && <Fact label={t('field.model')}>{routine.model}</Fact>}
            </dl>
            <details className="card-more" open>
              <summary>{t('card.task')}</summary>
              <Markdown text={t(routinePrompt(routine, data?.botId ?? ''))} />
            </details>
          </>
        ) : (
          <h4>{event.title}</h4>
        )}
        {footer(event.kind === 'routine.create' ? t('card.createRoutine') : t('card.apply'))}
      </div>
    );
  }

  if (event.kind === 'project.grant') {
    const data = event.data as
      | { botId?: string; project?: Project; level?: AccessLevel | null; before?: AccessLevel }
      | undefined;
    const target = actions?.bots.find((b) => b.id === data?.botId);
    return (
      <div
        className={`card bot-card${open ? '' : ' settled'}`}
        style={target ? { ['--bot' as string]: target.avatar.color } : undefined}
      >
        <div className="card-kicker">
          <FolderIcon size={13} />
          {t('card.grantKicker')}
        </div>
        <div className="grant-line">
          {target && <Avatar avatar={target.avatar} size={30} />}
          <span className="grant-who">{target?.name ?? data?.botId}</span>
          <span className="arrow">→</span>
          <FolderIcon size={15} />
          <span className="grant-who">{data?.project?.name ?? ''}</span>
          {data?.before && (
            <>
              <LevelChip level={data.before} t={t} />
              <span className="arrow">→</span>
            </>
          )}
          {data?.level ? (
            <LevelChip level={data.level} t={t} />
          ) : (
            <span className="level-chip l-none">{t('level.none')}</span>
          )}
        </div>
        {data?.project?.folders && (
          <ul className="path-list">
            {data.project.folders.map((f) => (
              <li key={f} className="mono" title={f}>
                {f}
              </li>
            ))}
          </ul>
        )}
        {data?.level && <p className="editor-hint">{t(`levelHint.${data.level}`)}</p>}
        {footer(t('card.apply'))}
      </div>
    );
  }

  return (
    <div className={`card${open ? '' : ' settled'}`}>
      <h4>{event.title}</h4>
      {event.details && <Markdown text={event.details} />}
      {footer(t('card.approve'))}
    </div>
  );
}

function Resolved({ resolution, t }: { resolution?: ApprovalResolution; t: T }) {
  const ok = resolution === 'approved' || resolution === 'edited';
  return (
    <div className={`resolved${ok ? ' ok' : ''}`}>
      {ok ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
      {t(`card.resolved.${resolution ?? 'expired'}`)}
    </div>
  );
}

export function InfoCard({ event, t }: { event: Card; t: T }) {
  const actions = useContext(CardActionsContext);
  const data = event.data as Record<string, string | boolean | undefined>;
  if (event.kind === 'memory') {
    return (
      <div className="event-line">
        <MemoryIcon size={14} />
        <span>
          {data.action === 'forget' ? t('card.forgot') : t('card.remembered')}{' '}
          <span className="quote">{String(data.text ?? '')}</span>
        </span>
      </div>
    );
  }
  if (event.kind === 'bot.spawned' || event.kind === 'bot.delegated') {
    const bot = actions?.bots.find((b) => b.id === data.botId);
    const name = bot?.name ?? String(data.name ?? '');
    return (
      <div className="handoff" style={bot ? { ['--bot' as string]: bot.avatar.color } : undefined}>
        <div className="handoff-head">
          <BranchIcon size={14} />
          <span>
            {event.kind === 'bot.spawned'
              ? t('card.spawned', { name })
              : t('card.delegated', { name })}
          </span>
          {bot && (
            <button className="link" onClick={() => actions?.openBot(bot.id)}>
              {t('card.openBot')}
            </button>
          )}
        </div>
        {data.task && <p className="handoff-task">{String(data.task)}</p>}
        {data.error ? (
          <p className="handoff-error">{String(data.error)}</p>
        ) : (
          data.result && (
            <details className="card-more">
              <summary>{t('card.result')}</summary>
              <Markdown text={String(data.result)} />
            </details>
          )
        )}
      </div>
    );
  }
  return (
    <div className="card">
      <h4>{String(data.title ?? t('card.label'))}</h4>
      {data.body && <Markdown text={String(data.body)} />}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function personaLine(bot: Bot, t: T) {
  const p = bot.persona;
  return [
    p.tone,
    p.address && t('card.addresses', { address: p.address }),
    p.emoji !== 'none' && t(`editor.emoji.${p.emoji}`),
  ]
    .filter(Boolean)
    .join(' · ');
}

function show(value: unknown, key: string, t: T, projects: Project[] = []): string {
  if (value === undefined || value === null || value === '') return t('card.none');
  if (key === 'projects' && Array.isArray(value))
    return grantsLine(value as ProjectGrant[], projects, t) || t('card.none');
  if (key === 'engine') return t(`engine.${String(value)}`);
  if (key === 'effort') return t(`effort.${String(value)}`);
  if (key === 'sandbox') return t(`editor.sandbox.${String(value)}`);
  if (key === 'instructions') {
    const s = String(value);
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  }
  if (Array.isArray(value))
    return value.length ? value.map(String).map(connectionLabel).join(', ') : t('card.none');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== '' && v !== undefined)
      .map(([k, v]) => `${t(`field.persona.${k}`)}: ${String(v)}`)
      .join(' · ');
  }
  if (typeof value === 'boolean') return value ? t('card.yes') : t('card.no');
  return String(value);
}

function grantsLine(grants: ProjectGrant[], projects: Project[], t: T) {
  return grants
    .map(
      (g) =>
        `${projects.find((p) => p.id === g.project)?.name ?? g.project} (${t(`level.${g.level}`)})`,
    )
    .join(', ');
}

function lastSegment(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
