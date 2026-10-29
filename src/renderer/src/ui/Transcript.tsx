import type { Bot } from '../../../shared/bots';
import type { Language } from '../../../shared/i18n';
import { Avatar } from './Avatar';
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  FileIcon,
  PenIcon,
  PlugIcon,
  SearchIcon,
  SpinnerIcon,
  TerminalIcon,
} from './icons';
import { formatDuration, type BotStatus, type ToolStep, type Turn, type TurnBlock } from './state';
import type { T } from './strings';
import { Markdown } from './Markdown';
import { ApprovalCard, InfoCard } from './Cards';

export function KindIcon({ kind, size = 14 }: { kind: ToolStep['kind']; size?: number }) {
  if (kind === 'file_read') return <FileIcon size={size} />;
  if (kind === 'file_write') return <PenIcon size={size} />;
  if (kind === 'command') return <TerminalIcon size={size} />;
  if (kind === 'search') return <SearchIcon size={size} />;
  return <PlugIcon size={size} />;
}

export function Transcript({
  bot,
  turns,
  status,
  t,
  language,
}: {
  bot: Bot;
  turns: Turn[];
  status?: BotStatus;
  t: T;
  language: Language;
}) {
  return (
    <div className="transcript-inner">
      {turns.map((turn, i) => {
        const last = i === turns.length - 1;
        return (
          <div key={turn.user?.id ?? `turn-${i}`} style={{ display: 'contents' }}>
            {turn.user && <pre className="msg-user">{turn.user.text}</pre>}
            {(turn.blocks.length > 0 || (last && turn.running)) && (
              <div className="turn">
                <Avatar avatar={bot.avatar} size={28} state={last ? (status ?? 'idle') : 'idle'} />
                <div className="turn-body">
                  <div className="turn-name">{bot.name}</div>
                  {turn.blocks.map((block) => (
                    <Block key={block.key} block={block} bot={bot} t={t} language={language} />
                  ))}
                  {last && turn.running && turn.blocks.length === 0 && (
                    <span className="meta">{t(`status.${status ?? 'thinking'}`)}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Block({
  block,
  bot,
  t,
  language,
}: {
  block: TurnBlock;
  bot: Bot;
  t: T;
  language: Language;
}) {
  switch (block.type) {
    case 'text':
      return <Markdown text={block.text} />;
    case 'steps': {
      const active = block.steps.some((s) => s.running);
      const failed = block.steps.some((s) => s.failed);
      return (
        <details className="steps">
          <summary>
            {active ? (
              <SpinnerIcon size={14} />
            ) : failed ? (
              <AlertIcon size={14} />
            ) : (
              <CheckIcon size={14} />
            )}
            <span>{active ? t('steps.running') : t('steps.count', { n: block.steps.length })}</span>
            <span
              className="meta"
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {block.steps[block.steps.length - 1]?.title}
            </span>
            <ChevronIcon size={14} className="chev" />
          </summary>
          <ol>
            {block.steps.map((step) => (
              <li key={step.id} className="step">
                <KindIcon kind={step.kind} />
                <span className="kind">{t(`tool.${step.kind}`)}</span>
                <span className="what mono" title={step.args}>
                  {step.args || step.title}
                </span>
                {step.running ? (
                  <SpinnerIcon size={13} />
                ) : step.failed ? (
                  <AlertIcon size={13} style={{ color: 'var(--danger)' }} />
                ) : (
                  <CheckIcon size={13} style={{ color: 'var(--faint)' }} />
                )}
              </li>
            ))}
          </ol>
        </details>
      );
    }
    case 'error': {
      const auth = block.code === 'auth' || /authenticat|login|oauth/i.test(block.message);
      return (
        <div className="notice error" role="alert">
          <AlertIcon size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div>{auth ? t(`error.auth.${bot.engine}`) : t(block.message)}</div>
            {!auth && <div className="fix">{t('error.fix')}</div>}
          </div>
        </div>
      );
    }
    case 'notice':
      return <div className="notice warn">{t(block.text)}</div>;
    case 'meta': {
      const time = formatDuration(block.event.durationMs, language);
      const usage = block.event.usage;
      const tokens = usage ? usage.inputTokens + usage.outputTokens : 0;
      return (
        <span className="meta">
          {tokens
            ? t('run.meta', { time, tokens: new Intl.NumberFormat(language).format(tokens) })
            : t('run.metaTime', { time })}
        </span>
      );
    }
    case 'card':
      return <InfoCard event={block.event} t={t} />;
    case 'approval':
      return <ApprovalCard event={block.event} resolution={block.resolution} t={t} />;
  }
}
