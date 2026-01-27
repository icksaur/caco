/**
 * Display-Only Tools
 * 
 * These tools bypass the LLM context - they display content directly to the UI
 * and only return a confirmation to the agent. This saves tokens when users
 * want to SEE data but don't need the agent to analyze it.
 * 
 * Usage patterns:
 *   "Show me the config" → render_file_contents (display-only)
 *   "What's wrong with my config" → read_file (agent needs content)
 */

import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';
import { readFile, stat } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fetchOEmbed, detectProvider, getSupportedProviders } from './oembed.js';

const execAsync = promisify(exec);

// Metadata must include a type field for categorizing outputs
interface OutputMeta {
  type: 'file' | 'terminal' | 'image' | 'embed' | 'raw';
  [key: string]: unknown;
}

type StoreOutputFn = (data: string | Buffer, metadata: OutputMeta) => string;
type DetectLanguageFn = (filepath: string) => string;

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * Create display tools that use a provided storeOutput function
 */
export function createDisplayTools(storeOutput: StoreOutputFn, detectLanguage: DetectLanguageFn) {
  
  const renderFileContents = defineTool('render_file_contents', {
    description: `Display file to user without loading into context. Use for "show me" requests. You receive confirmation only, not contents.`,

    parameters: z.object({
      path: z.string().describe('Absolute path to the file to display'),
      startLine: z.number().optional().describe('First line to show (1-indexed)'),
      endLine: z.number().optional().describe('Last line to show (inclusive)'),
      highlight: z.string().optional().describe('Language for syntax highlighting (auto-detected if omitted)')
    }),

    handler: async ({ path, startLine, endLine, highlight }) => {
      try {
        // Check if file exists and get size
        const stats = await stat(path);
        if (!stats.isFile()) {
          return { textResultForLlm: `Error: ${path} is not a file`, resultType: 'error' as const };
        }
        
        const content = await readFile(path, 'utf-8');
        const lines = content.split('\n');
        
        // Apply line range if specified
        const start = (startLine || 1) - 1;
        const end = endLine ? Math.min(endLine, lines.length) : lines.length;
        const displayContent = lines.slice(start, end).join('\n');
        
        // Store as output - this goes to UI, not to agent
        const outputId = storeOutput(displayContent, {
          type: 'file',
          path,
          highlight: highlight || detectLanguage(path),
          startLine: start + 1,
          endLine: end,
          totalLines: lines.length
        });
        
        // Agent only sees this tiny confirmation
        const rangeInfo = startLine || endLine 
          ? ` (lines ${start + 1}-${end} of ${lines.length})`
          : '';
          
        return {
          textResultForLlm: `[output:${outputId}] Displayed ${path} to user${rangeInfo} - ${lines.length} lines, ${content.length} bytes`,
          toolTelemetry: {
            outputId,
            lineCount: lines.length,
            byteCount: content.length,
            displayedLines: end - start
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { 
          textResultForLlm: `Error reading file: ${message}`,
          resultType: 'error' as const
        };
      }
    }
  });

  const runAndDisplay = defineTool('run_and_display', {
    description: `Run command and display output to user. You receive exit code only, not output. Use when user wants to see results without analysis.`,

    parameters: z.object({
      command: z.string().describe('Shell command to execute'),
      cwd: z.string().optional().describe('Working directory for the command')
    }),
  
    handler: async ({ command, cwd }) => {
      try {
        const options = { 
          cwd: cwd || process.cwd(),
          maxBuffer: 10 * 1024 * 1024,  // 10MB
          timeout: 60000  // 60 seconds
        };
        
        const { stdout, stderr } = await execAsync(command, options);
        const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : '');
        const lineCount = output.split('\n').length;
        
        const outputId = storeOutput(output, {
          type: 'terminal',
          command,
          cwd: options.cwd,
          exitCode: 0
        });
        
        return {
          textResultForLlm: `[output:${outputId}] Command succeeded. Output displayed to user (${lineCount} lines, ${output.length} chars)`,
          toolTelemetry: { outputId, exitCode: 0, outputSize: output.length, lineCount }
        };
      } catch (err) {
        // Command failed - still show output
        const execErr = err as ExecError;
        const output = (execErr.stdout || '') + (execErr.stderr ? `\n--- stderr ---\n${execErr.stderr}` : '');
        const exitCode = execErr.code || 1;
        const lineCount = output.split('\n').length;
        
        const outputId = storeOutput(output || execErr.message, {
          type: 'terminal',
          command,
          cwd: cwd || process.cwd(),
          exitCode
        });
        
        return {
          textResultForLlm: `[output:${outputId}] Command failed (exit ${exitCode}). Output displayed to user (${lineCount} lines)`,
          toolTelemetry: { outputId, exitCode, outputSize: output.length, lineCount }
        };
      }
    }
  });

  const displayImage = defineTool('display_image', {
    description: `Display image file to user. Supports PNG, JPEG, GIF, WebP, SVG.`,

    parameters: z.object({
      path: z.string().describe('Absolute path to the image file')
    }),
  
    handler: async ({ path }) => {
      try {
        const data = await readFile(path);
        const ext = path.split('.').pop()?.toLowerCase() ?? '';
        
        const mimeTypes: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          svg: 'image/svg+xml'
        };
        
        const mimeType = mimeTypes[ext] || 'application/octet-stream';
        
        const outputId = storeOutput(data, {
          type: 'image',
          path,
          mimeType
        });
        
        return {
          textResultForLlm: `[output:${outputId}] Displayed image ${path} to user (${data.length} bytes)`,
          toolTelemetry: { outputId, mimeType, size: data.length }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          textResultForLlm: `Error loading image: ${message}`,
          resultType: 'error' as const
        };
      }
    }
  });

  // Build provider list for tool description
  const providerList = getSupportedProviders()
    .map(p => p.name)
    .join(', ');

  const embedMedia = defineTool('embed_media', {
    description: `Embed media (YouTube, Vimeo, SoundCloud, Spotify) inline in chat.`,

    parameters: z.object({
      url: z.string().describe('URL of the media to embed (YouTube, SoundCloud, Vimeo, Spotify, Twitter/X)')
    }),

    handler: async ({ url }) => {
      try {
        // Check if URL is supported
        const provider = detectProvider(url);
        if (!provider) {
          return {
            textResultForLlm: `Unsupported media URL. Supported: ${providerList}`,
            resultType: 'error' as const
          };
        }

        // Fetch oEmbed data
        const embedData = await fetchOEmbed(url);

        // Store embed HTML for display
        const outputId = storeOutput(embedData.html, {
          type: 'embed',
          provider: embedData.provider,
          providerKey: embedData.providerKey,
          title: embedData.title,
          author: embedData.author,
          url,
          thumbnailUrl: embedData.thumbnailUrl
        });

        const info = embedData.title 
          ? `"${embedData.title}"${embedData.author ? ` by ${embedData.author}` : ''}`
          : url;

        return {
          textResultForLlm: `[output:${outputId}] Embedded ${embedData.provider} content: ${info}`,
          toolTelemetry: { 
            outputId, 
            provider: embedData.provider,
            title: embedData.title,
            author: embedData.author
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          textResultForLlm: `Error embedding media: ${message}`,
          resultType: 'error' as const
        };
      }
    }
  });

  return [renderFileContents, runAndDisplay, displayImage, embedMedia];
}
