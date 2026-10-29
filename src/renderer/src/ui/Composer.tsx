import { useLayoutEffect, useRef } from 'react';
import type { Bot, EngineId } from '../../../shared/bots';
import type { EngineModel } from '../../../shared/api';
import { SendIcon, StopIcon } from './icons';
import { Menu } from './Menu';
import type { T } from './strings';

const efforts: Bot['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function Composer({
  bot,
  value,
  models,
  busy,
  locked,
  t,
  onChange,
  onSend,
  onCancel,
  onEngine,
  onModel,
  onEffort,
  inputRef,
}: {
  bot: Bot;
  value: string;
  models: EngineModel[];
  busy: boolean;
  locked: boolean;
  t: T;
  onChange(text: string): void;
  onSend(): void;
  onCancel(): void;
  onEngine(engine: EngineId): void;
  onModel(model: string): void;
  onEffort(effort: Bot['effort']): void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const local = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = local.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const modelIds = [...new Set([bot.model, ...models.map((m) => m.id)].filter(Boolean))];
  const modelLabel = (id: string) =>
    id === 'default' ? t('composer.defaultModel') : (models.find((m) => m.id === id)?.label ?? id);

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onSend();
        }}
      >
        <textarea
          ref={(el) => {
            local.current = el;
            inputRef.current = el;
          }}
          rows={1}
          value={value}
          placeholder={t('composer.placeholder', { name: bot.name })}
          aria-label={t('chat.prompt')}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!busy && value.trim()) onSend();
            }
          }}
        />
        <div className="composer-bar">
          <div className="engine-switch" role="group" aria-label={t('engine.label')}>
            {(['claude', 'codex'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={bot.engine === id}
                disabled={locked}
                onClick={() => bot.engine !== id && onEngine(id)}
              >
                {t(`engine.${id}`)}
              </button>
            ))}
          </div>
          <Menu
            label={t('composer.model')}
            value={bot.model}
            disabled={locked}
            placement="up"
            options={modelIds.map((id) => ({ value: id, label: modelLabel(id) }))}
            onChange={onModel}
          />
          <Menu
            label={t('composer.effort')}
            value={bot.effort}
            disabled={locked}
            placement="up"
            options={efforts.map((id) => ({
              value: id,
              label: t(`effort.${id}`),
              hint: t(`effortHint.${id}`),
            }))}
            onChange={(effort) => onEffort(effort as Bot['effort'])}
          />
          {busy ? (
            <button
              type="button"
              className="send stop"
              onClick={onCancel}
              aria-label={t('chat.cancel')}
            >
              <StopIcon size={16} />
            </button>
          ) : (
            <button
              type="submit"
              className="send"
              disabled={!value.trim()}
              aria-label={t('chat.send')}
            >
              <SendIcon size={17} />
            </button>
          )}
        </div>
      </form>
      <p className="hint">{t('composer.hint')}</p>
    </div>
  );
}
