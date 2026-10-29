import { EventEmitter } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  projectDraftSchema,
  projectSchema,
  type Project,
  type ProjectDraft,
} from '../shared/projects';
import type { SettingsStore } from './settings';
import type { BotStore } from './bots/store';
import { inScope } from './engines/scopes';

export async function assertProjectKnowledge(
  projects: Project[],
  knowledgeDir?: string,
): Promise<void> {
  if (!knowledgeDir) return;
  for (const project of projects)
    for (const folder of project.folders)
      if ((await inScope(folder, [knowledgeDir])) || (await inScope(knowledgeDir, [folder])))
        throw new Error('errors.projectKnowledge');
}
export class ProjectStore extends EventEmitter {
  private queue = Promise.resolve();
  constructor(
    private settings: SettingsStore,
    private bots: () => BotStore,
  ) {
    super();
  }
  list(): Project[] {
    return this.settings.get().projects;
  }
  async preview(input: ProjectDraft): Promise<Project> {
    const draft = projectDraftSchema.parse(input);
    if (draft.id && !this.list().some((project) => project.id === draft.id))
      throw new Error('errors.projectMissing');
    const folders: string[] = [];
    for (const folder of draft.folders) {
      if (!isAbsolute(folder)) throw new Error('errors.absolutePath');
      let normalized: string;
      try {
        normalized = await realpath(folder);
        if (!(await stat(normalized)).isDirectory()) throw new Error('errors.projectFolder');
      } catch {
        throw new Error('errors.projectFolder');
      }
      if (
        !folders.some((value) =>
          process.platform === 'win32'
            ? value.toLowerCase() === normalized.toLowerCase()
            : value === normalized,
        )
      )
        folders.push(normalized);
    }
    const slug =
      draft.name
        .toLocaleLowerCase('tr')
        .replace(/ı/g, 'i')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 56) || 'project';
    let id = draft.id ?? slug;
    if (!draft.id)
      for (let n = 2; this.list().some((project) => project.id === id); n++) id = slug + '-' + n;
    const project = projectSchema.parse({ ...draft, id, folders });
    await assertProjectKnowledge([project], this.settings.get().knowledgeDir);
    return project;
  }
  save(input: ProjectDraft): Promise<Project> {
    return this.mutate(async () => {
      const project = await this.preview(input);
      await this.settings.changeProjects((projects) => [
        ...projects.filter((value) => value.id !== project.id),
        project,
      ]);
      this.emit('changed');
      return project;
    });
  }
  delete(id: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.list().some((project) => project.id === id))
        throw new Error('errors.projectMissing');
      await this.bots().removeProject(id, () =>
        this.settings.changeProjects((projects) => projects.filter((project) => project.id !== id)),
      );
      this.emit('changed');
    });
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
