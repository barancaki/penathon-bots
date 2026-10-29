import { useEffect, useState } from 'react';
import type { ConnectionInfo, EngineModel } from '../../../shared/api';
import type { AccessLevel, Project } from '../../../shared/projects';
import type { Bot, BotDraft, BotPatch, EngineId, Persona } from '../../../shared/bots';
import { Avatar } from './Avatar';
import { AvatarPicker } from './AvatarPicker';
import { CloseIcon, FolderIcon, PlusIcon, TrashIcon } from './icons';
import { Menu } from './Menu';
import type { T } from './strings';

type Tab = 'identity' | 'voice' | 'engine' | 'projects' | 'connections' | 'memory' | 'instructions';
const efforts: Bot['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max'];
const sandboxes: Bot['sandbox'][] = ['read-only', 'workspace-write', 'danger-full-access'];
const levels: AccessLevel[] = ['read', 'write', 'full'];

export function draftOf(bot: Bot): BotDraft {
  const draft: Partial<Bot> = { ...bot };
  delete draft.id;
  delete draft.system;
  delete draft.routines;
  return draft as BotDraft;
}
const patchOf = (bot: Bot): BotPatch => draftOf(bot);

/**
 * The bot's profile card. Opened from the conversation header to review or
 * fix a bot, and from a "New bot" approval card to adjust the draft before it
 * is created. Talking to the bot stays the main way to change it; this is the
 * place to see everything at once.
 */
export function BotEditor({
  bot: initial,
  mode,
  bots,
  t,
  onClose,
  onSaved,
  onApprove,
  onError,
  onOpenProjects,
}: {
  bot: Bot;
  /** `edit` saves through the API; `draft` hands the edited draft back to the approval card. */
  mode: 'edit' | 'draft';
  bots: Bot[];
  t: T;
  onClose(): void;
  onSaved?(bot: Bot): void;
  onApprove?(draft: BotDraft): void;
  onError(err: unknown): void;
  /** Opens the Projects sheet, e.g. to create a project that doesn't exist yet. */
  onOpenProjects?(): void;
}) {
  const [bot, setBot] = useState<Bot>(initial);
  const [tab, setTab] = useState<Tab>('identity');
  const [models, setModels] = useState<EngineModel[]>([]);
  const [connections, setConnections] = useState<ConnectionInfo[]>();
  const [projects, setProjects] = useState<Project[]>();
  const [memory, setMemory] = useState<string>();
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Bot>) => setBot((b) => ({ ...b, ...patch }));
  const setPersona = (patch: Partial<Persona>) =>
    setBot((b) => ({ ...b, persona: { ...b.persona, ...patch } }));
  const parent = bots.find((b) => b.id === bot.parent);
  const others = bots.filter((b) => b.id !== initial.id).map((b) => b.avatar);

  useEffect(() => {
    let live = true;
    void window.api.engines
      .models(bot.engine)
      .then((m) => live && setModels(m))
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [bot.engine]);

  useEffect(() => {
    if (tab !== 'projects') return;
    const load = () =>
      void window.api.projects
        .list()
        .then(setProjects)
        .catch(() => setProjects([]));
    load();
    return window.api.projects.onChanged(load);
  }, [tab]);

  useEffect(() => {
    if (tab !== 'connections' || connections) return;
    void window.api.connections
      .list()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, [tab, connections]);

  useEffect(() => {
    if (mode !== 'edit' || tab !== 'memory' || memory !== undefined) return;
    void window.api.bots.memory
      .get(initial.id)
      .then(setMemory)
      .catch(() => setMemory(''));
  }, [mode, tab, memory, initial.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!bot.name.trim()) return setTab('identity');
    if (mode === 'draft') return onApprove?.(draftOf(bot));
    setSaving(true);
    try {
      if (memoryDirty && memory !== undefined) await window.api.bots.memory.set(bot.id, memory);
      const saved = await window.api.bots.update(bot.id, patchOf(bot));
      onSaved?.(saved);
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      await window.api.bots.delete(bot.id);
      onClose();
    } catch (err) {
      onError(err);
    }
  };

  const makePermanent = async () => {
    try {
      const saved = await window.api.bots.makePermanent(bot.id);
      setBot(saved);
      onSaved?.(saved);
    } catch (err) {
      onError(err);
    }
  };

  const tabs: Tab[] = [
    'identity',
    'voice',
    'engine',
    'projects',
    'connections',
    ...(mode === 'edit' ? (['memory'] as const) : []),
    'instructions',
  ];
  const allConnections = bot.connections.includes('*');
  // Each engine sees its own servers: Claude the claude.ai and user MCPs, Codex its config.toml ones.
  const engineConnections = (connections ?? []).filter((c) =>
    bot.engine === 'codex'
      ? (c.source as string) === 'codex'
      : c.source !== 'app' && (c.source as string) !== 'codex',
  );
  const toggleConnection = (name: string, on: boolean) =>
    set({
      connections: on
        ? [...new Set([...bot.connections.filter((c) => c !== '*'), name])]
        : bot.connections.filter((c) => c !== name),
    });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet editor"
        role="dialog"
        aria-modal="true"
        aria-label={
          mode === 'draft' ? t('editor.draftTitle') : t('editor.title', { name: bot.name })
        }
        style={{ ['--bot' as string]: bot.avatar.color }}
      >
        <div className="editor-head">
          <Avatar avatar={bot.avatar} size={44} state="idle" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{bot.name || t('editor.unnamed')}</h2>
            <div className="sub">
              {[
                bot.role,
                bot.temporary ? t('editor.temporary') : '',
                parent ? t('editor.childOf', { name: parent.name }) : '',
              ]
                .filter(Boolean)
                .join(' · ') || t(`engine.${bot.engine}`)}
            </div>
          </div>
          <button className="icon-btn" aria-label={t('settings.close')} onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </div>

        <div className="editor-tabs" role="tablist">
          {tabs.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              type="button"
            >
              {t(`editor.tab.${id}`)}
            </button>
          ))}
        </div>

        <div className="editor-body scroll">
          {tab === 'identity' && (
            <>
              <div className="field-grid">
                <label className="field">
                  <span className="field-label">{t('editor.name')}</span>
                  <input
                    value={bot.name}
                    maxLength={100}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{t('editor.role')}</span>
                  <input
                    value={bot.role}
                    maxLength={200}
                    placeholder={t('editor.rolePlaceholder')}
                    onChange={(e) => set({ role: e.target.value })}
                  />
                </label>
              </div>
              <AvatarPicker
                value={bot.avatar}
                others={others}
                t={t}
                onChange={(avatar) => set({ avatar })}
              />
            </>
          )}

          {tab === 'voice' && (
            <>
              <p className="editor-hint">{t('editor.voiceHint')}</p>
              <div className="field-grid">
                <label className="field">
                  <span className="field-label">{t('editor.tone')}</span>
                  <input
                    value={bot.persona.tone}
                    maxLength={200}
                    placeholder={t('editor.tonePlaceholder')}
                    onChange={(e) => setPersona({ tone: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">{t('editor.address')}</span>
                  <input
                    value={bot.persona.address}
                    maxLength={100}
                    placeholder={t('editor.addressPlaceholder')}
                    onChange={(e) => setPersona({ address: e.target.value })}
                  />
                </label>
              </div>
              <Segmented
                label={t('editor.emoji')}
                value={bot.persona.emoji}
                options={['none', 'some', 'lots'].map((v) => ({
                  value: v,
                  label: t(`editor.emoji.${v}`),
                }))}
                onChange={(emoji) => setPersona({ emoji: emoji as Persona['emoji'] })}
              />
              <Segmented
                label={t('editor.length')}
                value={bot.persona.length}
                options={['short', 'medium', 'long'].map((v) => ({
                  value: v,
                  label: t(`editor.length.${v}`),
                }))}
                onChange={(length) => setPersona({ length: length as Persona['length'] })}
              />
              <label className="field">
                <span className="field-label">{t('editor.notes')}</span>
                <textarea
                  rows={4}
                  value={bot.persona.notes}
                  maxLength={2000}
                  placeholder={t('editor.notesPlaceholder')}
                  onChange={(e) => setPersona({ notes: e.target.value })}
                />
              </label>
            </>
          )}

          {tab === 'engine' && (
            <>
              <Segmented
                label={t('engine.label')}
                value={bot.engine}
                options={(['claude', 'codex'] as const).map((v) => ({
                  value: v,
                  label: t(`engine.${v}`),
                }))}
                onChange={(engine) => set({ engine: engine as EngineId, model: 'default' })}
              />
              <div className="field-grid">
                <div className="field">
                  <span className="field-label">{t('composer.model')}</span>
                  <Menu
                    label={t('composer.model')}
                    value={bot.model}
                    className="pill pill-field"
                    options={[...new Set(['default', ...models.map((m) => m.id), bot.model])].map(
                      (id) => ({
                        value: id,
                        label:
                          id === 'default'
                            ? t('composer.defaultModel')
                            : (models.find((m) => m.id === id)?.label ?? id),
                      }),
                    )}
                    onChange={(model) => set({ model })}
                  />
                </div>
                <div className="field">
                  <span className="field-label">{t('composer.effort')}</span>
                  <Menu
                    label={t('composer.effort')}
                    value={bot.effort}
                    className="pill pill-field"
                    options={efforts.map((id) => ({
                      value: id,
                      label: t(`effort.${id}`),
                      hint: t(`effortHint.${id}`),
                    }))}
                    onChange={(effort) => set({ effort: effort as Bot['effort'] })}
                  />
                </div>
              </div>
            </>
          )}

          {tab === 'projects' && (
            <>
              <p className="editor-hint">{t('editor.projectsHint')}</p>
              {!projects && <p className="meta">{t('editor.loading')}</p>}
              {projects && (
                <ul className="grant-list">
                  {bot.projects.map((grant) => {
                    const project = projects.find((p) => p.id === grant.project);
                    if (!project) return null;
                    return (
                      <li key={grant.project}>
                        <FolderIcon size={16} />
                        <span className="grant-name">
                          <span>{project.name}</span>
                          <span className="meta mono" title={project.folders.join('\n')}>
                            {project.folders.map(lastSegment).join(', ')}
                          </span>
                        </span>
                        <div
                          className="segmented small"
                          role="radiogroup"
                          aria-label={project.name}
                        >
                          {levels.map((level) => (
                            <button
                              key={level}
                              type="button"
                              role="radio"
                              aria-checked={grant.level === level}
                              title={t(`levelHint.${level}`)}
                              onClick={() =>
                                set({
                                  projects: bot.projects.map((g) =>
                                    g.project === grant.project ? { ...g, level } : g,
                                  ),
                                })
                              }
                            >
                              {t(`level.${level}`)}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={t('editor.removeProject')}
                          title={t('editor.removeProject')}
                          onClick={() =>
                            set({
                              projects: bot.projects.filter((g) => g.project !== grant.project),
                            })
                          }
                        >
                          <CloseIcon size={14} />
                        </button>
                      </li>
                    );
                  })}
                  {bot.projects.length === 0 && (
                    <li className="grant-empty">{t('editor.noProjects')}</li>
                  )}
                </ul>
              )}
              {projects && (
                <div className="grant-add">
                  {projects
                    .filter((p) => !bot.projects.some((g) => g.project === p.id))
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="chip-btn"
                        onClick={() =>
                          set({ projects: [...bot.projects, { project: p.id, level: 'write' }] })
                        }
                      >
                        <PlusIcon size={13} />
                        {p.name}
                      </button>
                    ))}
                  {onOpenProjects && (
                    <button type="button" className="chip-btn quiet" onClick={onOpenProjects}>
                      <FolderIcon size={13} />
                      {t('editor.manageProjects')}
                    </button>
                  )}
                </div>
              )}
              <details className="advanced">
                <summary>{t('editor.ownFolder')}</summary>
                <div className="advanced-body">
                  <Segmented
                    label={t('editor.access')}
                    value={bot.sandbox}
                    options={sandboxes.map((v) => ({
                      value: v,
                      label: t(`editor.sandbox.${v}`),
                      hint: t(`editor.sandboxHint.${v}`),
                    }))}
                    onChange={(sandbox) => set({ sandbox: sandbox as Bot['sandbox'] })}
                  />
                  <label className="field">
                    <span className="field-label">{t('editor.workdir')}</span>
                    <input
                      className="mono"
                      value={bot.workdir}
                      onChange={(e) => set({ workdir: e.target.value })}
                    />
                  </label>
                  <div className="field-grid">
                    <PathList
                      label={t('editor.readScope')}
                      value={bot.readScope}
                      onChange={(readScope) => set({ readScope })}
                    />
                    <PathList
                      label={t('editor.writeScope')}
                      value={bot.writeScope}
                      onChange={(writeScope) => set({ writeScope })}
                    />
                  </div>
                </div>
              </details>
              {parent && (
                <p className="editor-hint">{t('editor.ceiling', { name: parent.name })}</p>
              )}
            </>
          )}

          {tab === 'connections' && (
            <>
              <label className="conn-row conn-all network-row">
                <input
                  type="checkbox"
                  checked={bot.network}
                  onChange={(e) => set({ network: e.target.checked })}
                />
                <span className="conn-name">
                  {t('editor.network')}
                  <span className="field-hint network-hint">{t('editor.networkHint')}</span>
                </span>
              </label>
              <p className="editor-hint">
                {bot.engine === 'codex'
                  ? t('editor.connectionsHintCodex')
                  : t('editor.connectionsHint')}
              </p>
              <label className="conn-row conn-all">
                <input
                  type="checkbox"
                  checked={allConnections}
                  onChange={(e) => set({ connections: e.target.checked ? ['*'] : [] })}
                />
                <span className="conn-name">{t('editor.connectionsAll')}</span>
              </label>
              {!connections && <p className="meta">{t('editor.loading')}</p>}
              {connections && engineConnections.length === 0 && (
                <p className="meta">
                  {bot.engine === 'codex'
                    ? t('editor.connectionsEmptyCodex')
                    : t('editor.connectionsEmpty')}
                </p>
              )}
              <div className="conn-list">
                {engineConnections.map((c) => (
                  <label key={c.name} className="conn-row">
                    <input
                      type="checkbox"
                      disabled={allConnections}
                      checked={allConnections || bot.connections.includes(c.name)}
                      onChange={(e) => toggleConnection(c.name, e.target.checked)}
                    />
                    <span className="conn-name">{connectionLabel(c.name)}</span>
                    <span className={`conn-status s-${c.status}`}>{t(`conn.${c.status}`)}</span>
                  </label>
                ))}
              </div>
            </>
          )}

          {tab === 'memory' && (
            <>
              <p className="editor-hint">{t('editor.memoryHint')}</p>
              <textarea
                className="mono memory-box"
                rows={14}
                value={memory ?? ''}
                disabled={memory === undefined}
                placeholder={memory === undefined ? t('editor.loading') : t('editor.memoryEmpty')}
                onChange={(e) => {
                  setMemory(e.target.value);
                  setMemoryDirty(true);
                }}
              />
            </>
          )}

          {tab === 'instructions' && (
            <>
              <p className="editor-hint">
                {bot.system ? t('editor.instructionsChief') : t('editor.instructionsHint')}
              </p>
              <textarea
                className="mono instructions-box"
                rows={16}
                value={bot.instructions}
                onChange={(e) => set({ instructions: e.target.value })}
              />
            </>
          )}
        </div>

        <div className="editor-foot">
          {mode === 'edit' && !bot.system && (
            <button
              type="button"
              className={`btn btn-quiet danger${confirmDelete ? ' armed' : ''}`}
              onClick={() => void remove()}
              onBlur={() => setConfirmDelete(false)}
            >
              <TrashIcon size={15} />
              {confirmDelete ? t('editor.deleteConfirm') : t('editor.delete')}
            </button>
          )}
          {mode === 'edit' && bot.temporary && (
            <button type="button" className="btn" onClick={() => void makePermanent()}>
              {t('editor.makePermanent')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            {t('editor.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !bot.name.trim()}
            onClick={() => void save()}
          >
            {mode === 'draft' ? t('editor.createEdited') : t('editor.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function connectionLabel(name: string) {
  return name.replace(/^claude\.ai[ _]/i, '');
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; hint?: string }[];
  onChange(value: string): void;
}) {
  const hint = options.find((o) => o.value === value)?.hint;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function PathList({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange(value: string[]): void;
}) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea
        className="mono"
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }}
      />
    </label>
  );
}

function lastSegment(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
