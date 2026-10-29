import type * as Sdk from '@anthropic-ai/claude-agent-sdk';
import { penathonTools, penathonResult } from './tools';

export function createPenathonServer(
  sdk: Pick<typeof Sdk, 'createSdkMcpServer' | 'tool'>,
  call: (name: string, args: unknown) => Promise<unknown>,
  chief = false,
) {
  return sdk.createSdkMcpServer({
    name: 'team',
    version: '1.0.0',
    tools: penathonTools(chief).map(({ name, schema, description }) =>
      sdk.tool(name, description, schema.shape, (args) => penathonResult(call, name, args)),
    ),
  });
}
