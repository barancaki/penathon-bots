import { afterEach, beforeEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { BotStore, chiefBot } from '../src/main/bots/store';
import { ProjectStore } from '../src/main/projects';
import { SettingsStore, type SecretStorage } from '../src/main/settings';
import { BotTools } from '../src/main/bots/tools';
import { Approvals } from '../src/main/bots/approvals';
import type { BotEvent } from '../src/shared/events';
import type { Repository } from '../src/main/db';
import type { ChatService } from '../src/main/chat';
import { removeTemporary, temporaryDirectory } from './helpers';

let dir: string;
let bots: BotStore;
let projects: ProjectStore;
let approvals: Approvals;
let events: BotEvent[];
let controller: AbortController;
const draft = { name: 'Worker', engine: 'claude' as const, instructions: 'Help' };
beforeEach(async () => {
  dir = await temporaryDirectory();
  const settings = new SettingsStore(join(dir, 'settings'), {} as SecretStorage);
  await settings.init();
  bots = new BotStore(
    join(dir, 'bots'),
    chiefBot(dir, 'en'),
    () => undefined,
    () => [],
    () => settings.get().projects,
  );
  await bots.init();
  projects = new ProjectStore(settings, () => bots);
  approvals = new Approvals();
  events = [];
  controller = new AbortController();
});
afterEach(async () => {
  controller.abort();
  await bots.close();
  await removeTemporary(dir);
});
function tools(callerId = 'chief') {
  return new BotTools(
    bots,
    {} as Repository,
    { isBotActive: () => false } as unknown as ChatService,
    approvals,
    callerId,
    'run',
    { depth: 0, budget: { spawned: 0 }, signal: controller.signal },
    (event) => events.push(event),
    projects,
  );
}
async function request() {
  await expect.poll(() => events.some((event) => event.type === 'approval.request')).toBe(true);
  return events.find((event) => event.type === 'approval.request')!;
}
it('shows all projects to Chief, only granted projects to others, and adds grants to list_bots', async () => {
  const first = await projects.save({ name: 'Acme', folders: [dir] });
  await projects.save({ name: 'Other', folders: [dir] });
  const worker = await bots.create(draft);
  await bots.grantProject('chief', worker.id, first.id, 'read');
  expect(await tools().call('list_projects', {})).toHaveLength(2);
  expect(await tools(worker.id).call('list_projects', {})).toEqual([{ ...first, level: 'read' }]);
  expect(await tools().call('list_bots', {})).toContainEqual(
    expect.objectContaining({ id: worker.id, projects: [{ project: first.id, level: 'read' }] }),
  );
});
it.each(['approved', 'rejected', 'expired'] as const)(
  'creates projects only after a generic approval: %s',
  async (decision) => {
    const pending = tools().call('create_project', {
      name: 'Acme',
      folders: [dir],
      description: 'Several repos',
    });
    const approval = await request();
    expect(approval.kind).toBeUndefined();
    expect(approval.details).toContain(dir);
    expect(projects.list()).toEqual([]);
    if (decision === 'expired') controller.abort();
    else await approvals.respond(approval.approvalId, decision);
    await pending;
    expect(projects.list()).toHaveLength(decision === 'approved' ? 1 : 0);
  },
);
it('requires Chief to create projects and validates input before asking', async () => {
  const worker = await bots.create(draft);
  await expect(
    tools(worker.id).call('create_project', { name: 'Denied', folders: [dir] }),
  ).rejects.toThrow('Şef');
  await expect(
    tools().call('create_project', { name: 'Denied', folders: ['relative'] }),
  ).rejects.toThrow();
  expect(events).toEqual([]);
});
it.each(['approved', 'rejected', 'expired'] as const)(
  'applies grants only after structured approval: %s',
  async (decision) => {
    const project = await projects.save({ name: 'Acme', folders: [dir] });
    const worker = await bots.create(draft);
    const pending = tools().call('grant_project', {
      botId: worker.id,
      projectId: project.id,
      level: 'write',
    });
    const approval = await request();
    expect(approval).toMatchObject({
      kind: 'project.grant',
      data: { botId: worker.id, project, level: 'write', before: null },
    });
    expect(bots.get(worker.id).projects).toEqual([]);
    if (decision === 'expired') controller.abort();
    else await approvals.respond(approval.approvalId, decision);
    await pending;
    expect(bots.get(worker.id).projects).toEqual(
      decision === 'approved' ? [{ project: project.id, level: 'write' }] : [],
    );
  },
);
it('limits ordinary grants to descendants and own level, including self and unrelated target denial', async () => {
  const project = await projects.save({ name: 'Project', folders: [dir] });
  const parent = await bots.create(draft);
  const child = await bots.create({ ...draft, name: 'Child' }, parent.id);
  const unrelated = await bots.create({ ...draft, name: 'Other' });
  await bots.grantProject('chief', parent.id, project.id, 'write');
  for (const botId of [parent.id, unrelated.id, 'chief'])
    await expect(
      tools(parent.id).call('grant_project', { botId, projectId: project.id, level: 'read' }),
    ).rejects.toThrow();
  await expect(
    tools(parent.id).call('grant_project', {
      botId: child.id,
      projectId: project.id,
      level: 'full',
    }),
  ).rejects.toThrow('seviyeni');
  const pending = tools(parent.id).call('grant_project', {
    botId: child.id,
    projectId: project.id,
    level: 'write',
  });
  const approval = await request();
  await approvals.respond(approval.approvalId, 'approved');
  await pending;
  expect(bots.get(child.id).projects).toEqual([{ project: project.id, level: 'write' }]);
  events = [];
  const remove = tools(parent.id).call('grant_project', {
    botId: child.id,
    projectId: project.id,
    level: null,
  });
  const removal = await request();
  expect(removal.data).toMatchObject({ before: 'write', level: null });
  await approvals.respond(removal.approvalId, 'approved');
  await remove;
  expect(bots.get(child.id).projects).toEqual([]);
});
it('revalidates caller permissions and project snapshots at approval time', async () => {
  const project = await projects.save({ name: 'Project', folders: [dir] });
  const parent = await bots.create(draft);
  const child = await bots.create({ ...draft, name: 'Child' }, parent.id);
  await bots.grantProject('chief', parent.id, project.id, 'write');
  const pending = tools(parent.id).call('grant_project', {
    botId: child.id,
    projectId: project.id,
    level: 'write',
  });
  const approval = await request();
  await bots.grantProject('chief', parent.id, project.id, 'read');
  await expect(approvals.respond(approval.approvalId, 'approved')).rejects.toThrow('seviyeni');
  expect(bots.get(child.id).projects).toEqual([]);
  await projects.save({ ...project, description: 'Changed' });
  await expect(approvals.respond(approval.approvalId, 'approved')).rejects.toThrow('değişti');
  await approvals.respond(approval.approvalId, 'rejected');
  await pending;
});
