// Interactive developer client. Each input line is one MCP request; no action retries.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'studio-live-validation', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(rootDir, 'src', 'server.mjs')], cwd: rootDir, stderr: 'pipe' });
transport.stderr?.on('data', data => process.stderr.write(data));
await client.connect(transport);
await fs.mkdir(join(rootDir, 'artifacts'), { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const recordPath = join(rootDir, 'artifacts', `live-${runId}.jsonl`);
console.log(JSON.stringify({ ready: true, server: client.getServerVersion() }));
const input = createInterface({ input: process.stdin });
let latestToken, sequence = 0;
for await (const line of input) {
  try {
    const request = JSON.parse(line);
    if (request.close) break;
    const args = request.arguments || {};
    if (request.with_token) {
      if (!latestToken) throw new Error('Observe before sending an input action.');
      args.observation_token = latestToken;
      latestToken = undefined;
    }
    const result = await client.callTool({ name: request.tool, arguments: args });
    const data = result.structuredContent || JSON.parse(result.content.find(block => block.type === 'text')?.text || '{}');
    if (data.observation_token) latestToken = data.observation_token;
    const screenshots = [];
    for (const block of result.content || []) {
      if (block.type === 'image') {
        const extension = block.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const path = join(rootDir, 'artifacts', `live-${runId}-${++sequence}.${extension}`);
        await fs.writeFile(path, Buffer.from(block.data, 'base64'));
        screenshots.push(path);
      }
    }
    const record = { tool: request.tool, isError: Boolean(result.isError), data, screenshots };
    await fs.appendFile(recordPath, JSON.stringify(record) + '\n');
    console.log(JSON.stringify(record));
  } catch (error) { console.log(JSON.stringify({ error: error.message })); }
}
input.close();
process.stdin.pause();
await client.close();
