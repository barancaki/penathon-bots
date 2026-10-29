import { useEffect, useState } from 'react';
import type { Bot } from '../../../shared/bots';
import type { AccessLevel, Project, ProjectDraft } from '../../../shared/projects';
import { Avatar } from './Avatar';
import { CloseIcon, FolderIcon, PlusIcon, TrashIcon } from './icons';
import type { T } from './strings';

/**
 * Projects: named groups of folders ("Acme" = three repos). Bots get a
 * project with a level; here the user sees every project, its folders and who
 * can work in it. Adding folders later is the common case, so it's one click.
 */
export function ProjectsSheet({
  projects,
  bots,
  t,
  initialId,
  onClose,
  onError,
}: {
  projects: Project[];
  bots: Bot[];
  t: T;
  initialId?: string | 'new';
  onClose(): void;
  onError(err: unknown): void;
}) {
  const [selected, setSelected] = useState<string | 'new' | undefined>(
    initialId ?? projects[0]?.id ?? 'new',
  );
  const current = projects.find((p) => p.id === selected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet projects-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('projects.title')}
      >
        <div className="editor-head">
          <span className="profile-mark">
            <FolderIcon size={18} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{t('projects.title')}</h2>
            <div className="sub">{t('projects.hint')}</div>
          </div>
          <button className="icon-btn" aria-label={t('settings.close')} onClick={onClose}>
            <CloseIcon size={17} />
          </button>
        </div>
        <div className="projects-layout">
          <nav className="project-list scroll" aria-label={t('projects.title')}>
            {projects.map((p) => (
              <button
                key={p.id}
                className="project-item"
                aria-current={p.id === selected}
                onClick={() => setSelected(p.id)}
              >
                <FolderIcon size={15} />
                <span className="project-item-name">{p.name}</span>
                <span className="meta">{p.folders.length}</span>
              </button>
            ))}
            <button
              className="project-item add"
              aria-current={selected === 'new'}
              onClick={() => setSelected('new')}
            >
              <PlusIcon size={15} />
              <span>{t('projects.new')}</span>
            </button>
          </nav>
          <ProjectForm
            key={selected}
            project={current}
            bots={bots}
            t={t}
            onSaved={(p) => setSelected(p.id)}
            onDeleted={() => setSelected(projects.find((p) => p.id !== selected)?.id ?? 'new')}
            onError={onError}
          />
        </div>
      </div>
    </div>
  );
}

function ProjectForm({
  project,
  bots,
  t,
  onSaved,
  onDeleted,
  onError,
}: {
  project?: Project;
  bots: Bot[];
  t: T;
  onSaved(p: Project): void;
  onDeleted(): void;
  onError(err: unknown): void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [folders, setFolders] = useState<string[]>(project?.folders ?? []);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty =
    !project ||
    name !== project.name ||
    description !== project.description ||
    folders.join('\n') !== project.folders.join('\n');
  const members = project
    ? bots.flatMap((b) => {
        const grant = b.projects?.find((g) => g.project === project.id);
        return grant ? [{ bot: b, level: grant.level }] : [];
      })
    : [];

  const addFolder = async () => {
    try {
      const folder = await window.api.projects.pickFolder();
      if (folder && !folders.includes(folder)) {
        const next = [...folders, folder];
        setFolders(next);
        if (!name.trim()) setName(lastSegment(folder));
      }
    } catch (err) {
      onError(err);
    }
  };

  const save = async () => {
    if (!name.trim() || !folders.length) return;
    setSaving(true);
    try {
      const draft: ProjectDraft = { name: name.trim(), description: description.trim(), folders };
      if (project) draft.id = project.id;
      onSaved(await window.api.projects.save(draft));
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!project) return;
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      await window.api.projects.delete(project.id);
      onDeleted();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="project-form">
      <div className="editor-body scroll">
        <div className="field-grid">
          <label className="field">
            <span className="field-label">{t('projects.name')}</span>
            <input
              value={name}
              maxLength={100}
              placeholder={t('projects.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('projects.description')}</span>
            <input
              value={description}
              maxLength={300}
              placeholder={t('projects.descriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
        <div className="field">
          <span className="field-label">{t('projects.folders')}</span>
          <ul className="folder-list">
            {folders.map((f) => (
              <li key={f}>
                <FolderIcon size={15} />
                <span className="mono folder-path" title={f}>
                  {f}
                </span>
                <button
                  className="icon-btn"
                  aria-label={t('projects.removeFolder')}
                  title={t('projects.removeFolder')}
                  onClick={() => setFolders(folders.filter((x) => x !== f))}
                >
                  <CloseIcon size={14} />
                </button>
              </li>
            ))}
            <li className="folder-add">
              <button type="button" className="btn btn-quiet" onClick={() => void addFolder()}>
                <PlusIcon size={15} />
                {t('projects.addFolder')}
              </button>
            </li>
          </ul>
        </div>
        {project && (
          <div className="field">
            <span className="field-label">{t('projects.members')}</span>
            {members.length ? (
              <ul className="member-list">
                {members.map(({ bot, level }) => (
                  <li key={bot.id} style={{ ['--bot' as string]: bot.avatar.color }}>
                    <Avatar avatar={bot.avatar} size={24} />
                    <span>{bot.name}</span>
                    <LevelChip level={level} t={t} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="editor-hint">{t('projects.noMembers')}</p>
            )}
          </div>
        )}
      </div>
      <div className="editor-foot">
        {project && (
          <button
            type="button"
            className={`btn btn-quiet danger${confirmDelete ? ' armed' : ''}`}
            onClick={() => void remove()}
            onBlur={() => setConfirmDelete(false)}
          >
            <TrashIcon size={15} />
            {confirmDelete ? t('projects.deleteConfirm') : t('projects.delete')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !dirty || !name.trim() || !folders.length}
          onClick={() => void save()}
        >
          {project ? t('editor.save') : t('projects.create')}
        </button>
      </div>
    </div>
  );
}

export function LevelChip({ level, t }: { level: AccessLevel; t: T }) {
  return <span className={`level-chip l-${level}`}>{t(`level.${level}`)}</span>;
}

function lastSegment(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
