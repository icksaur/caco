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

/**
 * Create display tools that use a provided storeOutput function
 * @param {Function} storeOutput - (data, metadata) => outputId
 * @param {Function} detectLanguage - (filepath) => language string
 */
export function createDisplayTools(storeOutput, detectLanguage) {
  
  const renderFileContents = defineTool('render_file_contents', {
    description: `Display a file's contents directly to the user without reading it into context.
  
USE THIS TOOL WHEN:
- User asks to "show", "display", "print", "cat", or "view" a file
- User wants to see file contents but hasn't asked for analysis
- User says "let me see", "show me", "what's in"

DO NOT USE WHEN:
- User asks to analyze, fix, modify, or understand the file
- User asks "what's wrong with" or "explain" the file
- You need to reference the file contents in your response

This tool renders the file directly to the UI. You will only receive
confirmation that the file was displayed, not its contents.`,

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
          return { textResultForLlm: `Error: ${path} is not a file`, resultType: 'error' };
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
          textResultForLlm: `Displayed ${path} to user${rangeInfo} - ${lines.length} lines, ${content.length} bytes`,
          toolTelemetry: {
            outputId,
            lineCount: lines.length,
            byteCount: content.length,
            displayedLines: end - start
          }
        };
      } catch (err) {
        return { 
          textResultForLlm: `Error reading file: ${err.message}`,
          resultType: 'error'
        };
      }
    }
  });

  const runAndDisplay = defineTool('run_and_display', {
    description: `Run a command and display its output directly to the user.
  
USE THIS WHEN:
- User wants to see command output but not have it analyzed
- Examples: "run the tests", "show me the git log", "list the files"

DO NOT USE WHEN:
- User wants you to analyze, explain, or act on the output
- You need to parse the output to answer a question

You will receive exit code and output size, not the actual output.`,

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
          textResultForLlm: `Command succeeded. Output displayed to user (${lineCount} lines, ${output.length} chars)`,
          toolTelemetry: { outputId, exitCode: 0, outputSize: output.length, lineCount }
        };
      } catch (err) {
        // Command failed - still show output
        const output = (err.stdout || '') + (err.stderr ? `\n--- stderr ---\n${err.stderr}` : '');
        const exitCode = err.code || 1;
        const lineCount = output.split('\n').length;
        
        const outputId = storeOutput(output || err.message, {
          type: 'terminal',
          command,
          cwd: cwd || process.cwd(),
          exitCode
        });
        
        return {
          textResultForLlm: `Command failed (exit ${exitCode}). Output displayed to user (${lineCount} lines)`,
          toolTelemetry: { outputId, exitCode, outputSize: output.length, lineCount }
        };
      }
    }
  });

  const displayImage = defineTool('display_image', {
    description: `Display an image file directly to the user.
  
Use when user wants to see an image. You cannot see image contents.
Supports: PNG, JPEG, GIF, WebP, SVG`,

    parameters: z.object({
      path: z.string().describe('Absolute path to the image file')
    }),
  
    handler: async ({ path }) => {
      try {
        const data = await readFile(path);
        const ext = path.split('.').pop()?.toLowerCase();
        
        const mimeTypes = {
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
          textResultForLlm: `Displayed image ${path} to user (${data.length} bytes)`,
          toolTelemetry: { outputId, mimeType, size: data.length }
        };
      } catch (err) {
        return {
          textResultForLlm: `Error loading image: ${err.message}`,
          resultType: 'error'
        };
      }
    }
  });

  // Build provider list for tool description
  const providerList = getSupportedProviders()
    .map(p => p.name)
    .join(', ');

  const embedMedia = defineTool('embed_media', {
    description: `Embed media content (video, audio, etc.) directly in the chat.

USE THIS WHEN:
- User shares a YouTube, SoundCloud, Vimeo, or Spotify link
- User asks to play, embed, or show media from a URL
- User pastes a media URL and wants to see/hear it

SUPPORTED PROVIDERS: ${providerList}

The media player will be rendered inline in the conversation.
You will receive confirmation with title/author info.`,

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
            resultType: 'error'
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
          textResultForLlm: `Embedded ${embedData.provider} content: ${info}`,
          toolTelemetry: { 
            outputId, 
            provider: embedData.provider,
            title: embedData.title,
            author: embedData.author
          }
        };
      } catch (err) {
        return {
          textResultForLlm: `Error embedding media: ${err.message}`,
          resultType: 'error'
        };
      }
    }
  });

  return [renderFileContents, runAndDisplay, displayImage, embedMedia];
}
