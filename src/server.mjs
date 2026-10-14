#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStudioController } from './studio.mjs';
import { registerStudioTools } from './tools.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Stdout is reserved for MCP JSON-RPC. Diagnostics always go to stderr.
console.log = (...args) => console.error(...args);

const instructions = 'Control verified Insta360 Studio only. Call studio_status, studio_capabilities, then studio_observe. Defaults return fresh compact JPEG images; x/y use returned-image pixels and map internally to the physical window. UIA tree bounds are physical desktop pixels; use element_id for tree targets, never tree bounds as x/y. Qt UIA is skipped by default; request include_text=true for element IDs/accessibility typing, include_text=auto to reset, and output_detail=full or image_max_width=0 for detail. Inspect each image before choosing a visible target. Act once with its single-use observation_token; inspect the returned fresh image/token before continuing. Screenshot typing requires the immediately preceding click result; a separate observation clears its anchor. Do not guess targets, retry blindly or control another app. Keep originals intact. Use a checkpoint before export, verify expected settings and poll full decode to completed. expected_projection=equirectangular requires declared spherical metadata; a 2:1 image alone is insufficient, and metadata does not prove stitching quality. Generic UI access is not proof of every Studio workflow.';

let controller;
let server;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await server?.close(); } catch (error) { console.error('MCP shutdown:', error.message); }
  try { await controller?.close?.(); } catch (error) { console.error('Studio backend shutdown:', error.message); }
}

try {
  controller = await createStudioController({ rootDir });
  server = new McpServer(
    { name: 'insta360-studio', version: '0.4.0' },
    { instructions, maxToolInputElements: 2000 },
  );
  registerStudioTools(server, controller);
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`Insta360 Studio MCP failed to start: ${error.message}`);
  await close();
  process.exitCode = 1;
}
