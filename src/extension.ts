import * as vscode from 'vscode';
import * as axios from 'axios';
import * as path from 'path';
import * as diff from 'diff';

let chatHistory: string[] = []; // In-memory chat history

class AicaChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'aica.chat';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._getWebviewContent(chatHistory.join('\n'));

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendMessage':
          const userMsg = message.text;
          
          // Handle special commands
          if (userMsg.startsWith('/')) {
            await this._handleCommand(userMsg, webviewView.webview);
            return;
          }
          
          // Start streaming response
          webviewView.webview.postMessage({ command: 'startStreaming' });
          
          const fullPrompt = await this._buildChatPrompt(userMsg);
          const response = await getOllamaChat(fullPrompt, webviewView.webview);
          
          // Parse response for suggested code changes
          await this._parseAndHandleCodeSuggestions(response);
          
          chatHistory.push(`User: ${userMsg}\nAICA: ${response}`);
          if (!vscode.workspace.getConfiguration('aica').get<boolean>('chatHistory')) {
            chatHistory = chatHistory.slice(-10); // Limit to last 10 turns
          }
          break;
        case 'clearHistory':
          chatHistory = [];
          webviewView.webview.postMessage({ command: 'clearChat' });
          break;
        case 'scanCodebase':
          await vscode.commands.executeCommand('aica.scanCodebase');
          break;
        case 'attachFile':
          await vscode.commands.executeCommand('aica.attachFile');
          break;
        case 'applyEdit':
          await applyCodeEdit(message.diff, message.filePath);
          break;
        case 'previewCodeChange':
          await previewCodeChange(message.originalCode, message.newCode, message.filePath, message.description);
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('aica.openSettings');
          break;
      }
    });
  }

  private async _handleCommand(command: string, webview: vscode.Webview) {
    const parts = command.split(' ');
    const cmd = parts[0].toLowerCase();
    
    switch (cmd) {
      case '/read':
        if (parts.length < 2) {
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: 'Usage: /read <filepath>' });
          return;
        }
        const readPath = parts.slice(1).join(' ');
        try {
          const uri = vscode.Uri.file(readPath);
          const doc = await vscode.workspace.openTextDocument(uri);
          const content = doc.getText();
          chatHistory.push(`Read file: ${readPath}\n${content}`);
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: `Read ${readPath}:\n\`\`\`\n${content}\n\`\`\`` });
        } catch (error) {
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: `Error reading ${readPath}: ${error}` });
        }
        break;
        
      case '/write':
        if (parts.length < 3) {
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: 'Usage: /write <filepath> <content>' });
          return;
        }
        const writePath = parts[1];
        const writeContent = parts.slice(2).join(' ');
        try {
          const uri = vscode.Uri.file(writePath);
          const edit = new vscode.WorkspaceEdit();
          edit.createFile(uri, { ignoreIfExists: true });
          edit.replace(uri, new vscode.Range(0, 0, 0, 0), writeContent);
          await vscode.workspace.applyEdit(edit);
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: `Successfully wrote to ${writePath}` });
        } catch (error) {
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: `Error writing to ${writePath}: ${error}` });
        }
        break;
        
      case '/exec':
        if (parts.length < 2) {
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: 'Usage: /exec <command>' });
          return;
        }
        const execCommand = parts.slice(1).join(' ');
        const terminal = vscode.window.createTerminal('AICA');
        terminal.sendText(execCommand);
        terminal.show();
        webview.postMessage({ command: 'appendMessage', role: 'assistant', content: `Executed: ${execCommand}` });
        break;
        
      case '/list':
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          webview.postMessage({ command: 'appendMessage', role: 'assistant', content: 'No workspace open' });
          return;
        }
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
        const fileList = files.slice(0, 20).map(f => f.fsPath).join('\n');
        webview.postMessage({ command: 'appendMessage', role: 'assistant', content: `Files in workspace:\n${fileList}` });
        break;
        
      default:
        webview.postMessage({ command: 'appendMessage', role: 'assistant', content: `Unknown command: ${cmd}\nAvailable: /read, /write, /exec, /list` });
    }
  }

  private async _buildChatPrompt(userMsg: string): Promise<string> {
    // Enhanced context management with smart truncation and automatic codebase context
    const systemPrompt = `You are AICA, an AI coding assistant integrated into VSCode. You can:
- Review and analyze code
- Read/write files using /read and /write commands
- Execute terminal commands using /exec
- List workspace files using /list
- Apply code changes with diff previews
- Provide streaming responses for better UX

IMPORTANT: When suggesting code changes, you can trigger a preview interface similar to Cline by formatting your response with:

**SUGGESTED CHANGES FOR [filename]:**
[Brief description of what you're changing]

\`\`\`[language]
[Complete new file content]
\`\`\`

This will automatically show a side-by-side diff preview where the user can see original vs modified code and choose to apply or cancel the changes.

You have access to the current workspace and can see relevant files automatically.
Be helpful, concise, and focus on practical solutions based on the codebase context.`;

    let contextWindow = systemPrompt + '\n\n';
    let remainingLength = 12000 - contextWindow.length - userMsg.length - 100; // Increased context window
    
    // Add automatic codebase context based on the user's question
    const codebaseContext = await this._getRelevantCodebaseContext(userMsg, Math.floor(remainingLength * 0.6));
    if (codebaseContext) {
      contextWindow += codebaseContext + '\n\n';
      remainingLength -= codebaseContext.length;
    }
    
    // Add current file context if available
    const currentFileContext = await this._getCurrentFileContext();
    if (currentFileContext && remainingLength > currentFileContext.length + 100) {
      contextWindow += currentFileContext + '\n\n';
      remainingLength -= currentFileContext.length;
    }
    
    // Prioritize recent conversations and relevant context
    const relevantHistory = this._getRelevantContext(chatHistory, userMsg, remainingLength);
    contextWindow += relevantHistory;
    contextWindow += `\nUser: ${userMsg}\nAICA:`;
    
    return contextWindow;
  }

  private _getRelevantContext(history: string[], currentMsg: string, maxLength: number): string {
    if (history.length === 0) return '';
    
    // Join all history
    const fullHistory = history.join('\n');
    
    // If it fits, return all
    if (fullHistory.length <= maxLength) {
      return fullHistory;
    }
    
    // Smart truncation: keep recent messages and relevant context
    const lines = fullHistory.split('\n');
    const keywords = this._extractKeywords(currentMsg);
    
    // Score lines by relevance and recency
    const scoredLines = lines.map((line, index) => ({
      line,
      score: this._scoreLineRelevance(line, keywords, index, lines.length)
    }));
    
    // Sort by score and select top lines within length limit
    scoredLines.sort((a, b) => b.score - a.score);
    
    let result = '';
    for (const item of scoredLines) {
      if (result.length + item.line.length + 1 <= maxLength) {
        result += (result ? '\n' : '') + item.line;
      }
    }
    
    return result;
  }

  private _extractKeywords(text: string): string[] {
    // Extract meaningful keywords from user message
    const words = text.toLowerCase().match(/\b\w{3,}\b/g) || [];
    return [...new Set(words)].filter(word => 
      !['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 'did', 'she', 'use', 'way', 'what', 'when', 'with'].includes(word)
    );
  }

  private _scoreLineRelevance(line: string, keywords: string[], index: number, total: number): number {
    let score = 0;
    
    // Recency bonus (more recent = higher score)
    score += (index / total) * 10;
    
    // Keyword relevance
    const lowerLine = line.toLowerCase();
    for (const keyword of keywords) {
      if (lowerLine.includes(keyword)) {
        score += 5;
      }
    }
    
    // Code-related content bonus
    if (lowerLine.includes('function') || lowerLine.includes('class') || lowerLine.includes('import') || 
        lowerLine.includes('const') || lowerLine.includes('let') || lowerLine.includes('var') ||
        lowerLine.includes('```') || lowerLine.includes('error') || lowerLine.includes('bug')) {
      score += 3;
    }
    
    // File operations bonus
    if (lowerLine.includes('/read') || lowerLine.includes('/write') || lowerLine.includes('/exec') ||
        lowerLine.includes('attached:') || lowerLine.includes('read file:')) {
      score += 4;
    }
    
    return score;
  }

  private async _getRelevantCodebaseContext(userMsg: string, maxLength: number): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || maxLength < 100) {
      return '';
    }

    try {
      // Extract keywords from user message to find relevant files
      const keywords = this._extractKeywords(userMsg);
      const codeKeywords = this._extractCodeKeywords(userMsg);
      
      // Find relevant files based on keywords
      const files = await vscode.workspace.findFiles(
        '**/*.{ts,js,py,rs,go,jsx,tsx,cpp,c,java,json,md,txt,yml,yaml}',
        '**/node_modules/**',
        30
      );

      // Score files by relevance
      const scoredFiles: Array<{uri: vscode.Uri, score: number}> = [];
      
      for (const file of files) {
        const fileName = path.basename(file.fsPath).toLowerCase();
        const filePath = file.fsPath.toLowerCase();
        let score = 0;

        // Score based on filename and path matching keywords
        for (const keyword of keywords) {
          if (fileName.includes(keyword) || filePath.includes(keyword)) {
            score += 10;
          }
        }

        // Score based on code-related keywords
        for (const keyword of codeKeywords) {
          if (fileName.includes(keyword) || filePath.includes(keyword)) {
            score += 15;
          }
        }

        // Boost score for common important files
        if (fileName.includes('package.json') || fileName.includes('readme') || 
            fileName.includes('config') || fileName.includes('index') ||
            fileName.includes('main') || fileName.includes('app')) {
          score += 5;
        }

        if (score > 0) {
          scoredFiles.push({ uri: file, score });
        }
      }

      // Sort by score and take top files
      scoredFiles.sort((a, b) => b.score - a.score);
      const topFiles = scoredFiles.slice(0, 5);

      if (topFiles.length === 0) {
        // Fallback: include some recent/important files
        const fallbackFiles = files.slice(0, 3);
        for (const file of fallbackFiles) {
          topFiles.push({ uri: file, score: 1 });
        }
      }

      // Build context from selected files
      let context = 'CODEBASE CONTEXT:\n';
      let remainingLength = maxLength - context.length;

      for (const fileInfo of topFiles) {
        if (remainingLength < 200) break;

        try {
          const doc = await vscode.workspace.openTextDocument(fileInfo.uri);
          const content = doc.getText();
          const fileName = path.basename(fileInfo.uri.fsPath);
          
          // Truncate content if too long
          const maxFileContent = Math.min(remainingLength - 50, 800);
          const truncatedContent = content.length > maxFileContent 
            ? content.substring(0, maxFileContent) + '...'
            : content;

          const fileSection = `\n--- ${fileName} ---\n${truncatedContent}\n`;
          
          if (fileSection.length <= remainingLength) {
            context += fileSection;
            remainingLength -= fileSection.length;
          }
        } catch (error) {
          // Skip files that can't be read
          continue;
        }
      }

      return context.length > 50 ? context : '';
    } catch (error) {
      return '';
    }
  }

  private _extractCodeKeywords(text: string): string[] {
    // Extract code-specific keywords that might indicate what files to look for
    const codePatterns = [
      /\b(function|class|interface|type|const|let|var|import|export)\s+(\w+)/gi,
      /\b(component|service|controller|model|util|helper|config)\b/gi,
      /\.(ts|js|py|rs|go|jsx|tsx|cpp|c|java|json|yml|yaml)\b/gi,
      /\b(api|endpoint|route|handler|middleware)\b/gi,
      /\b(test|spec|mock|fixture)\b/gi
    ];

    const keywords: string[] = [];
    for (const pattern of codePatterns) {
      const matches = text.match(pattern);
      if (matches) {
        keywords.push(...matches.map(m => m.toLowerCase().replace(/[^\w]/g, '')));
      }
    }

    return [...new Set(keywords)].filter(k => k.length > 2);
  }

  private async _getCurrentFileContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '';
    }

    try {
      const doc = editor.document;
      const fileName = path.basename(doc.fileName);
      const content = doc.getText();
      
      // Limit content size
      const maxContent = 1500;
      const truncatedContent = content.length > maxContent 
        ? content.substring(0, maxContent) + '...'
        : content;

      return `CURRENT FILE CONTEXT:\n--- ${fileName} ---\n${truncatedContent}`;
    } catch (error) {
      return '';
    }
  }

  private _getWebviewContent(history: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>AICA Chat</title>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
          margin: 0; padding: 0; background: #1e1e1e; color: #d4d4d4; 
          display: flex; flex-direction: column; height: 100vh;
        }
        
        /* Header with token/cache info */
        .header {
          background: #252526; border-bottom: 1px solid #444; padding: 8px 12px;
          font-size: 11px; color: #888; display: flex; justify-content: space-between;
          align-items: center; flex-shrink: 0;
        }
        .token-info { display: flex; gap: 15px; }
        .model-info { font-weight: 500; color: #569cd6; }
        
        /* Chat area */
        .chat-container {
          flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column;
          gap: 12px; min-height: 0;
        }
        
        .message {
          display: flex; flex-direction: column; gap: 4px;
        }
        .message.user { align-items: flex-end; }
        .message.assistant { align-items: flex-start; }
        
        .message-header {
          font-size: 11px; color: #888; font-weight: 500;
        }
        
        .message-content {
          max-width: 85%; padding: 8px 12px; border-radius: 8px;
          white-space: pre-wrap; word-wrap: break-word; line-height: 1.4;
        }
        
        .message.user .message-content {
          background: #0e639c; color: #fff;
        }
        
        .message.assistant .message-content {
          background: #2d2d30; border: 1px solid #444;
        }
        
        /* Input area */
        .input-container {
          background: #252526; border-top: 1px solid #444; padding: 12px;
          flex-shrink: 0;
        }
        
        .input-wrapper {
          display: flex; flex-direction: column; gap: 8px;
        }
        
        textarea {
          width: 100%; min-height: 60px; max-height: 120px; padding: 8px;
          background: #1e1e1e; color: #d4d4d4; border: 1px solid #444;
          border-radius: 4px; resize: vertical; font-family: inherit;
          font-size: 13px; line-height: 1.4;
        }
        
        textarea:focus {
          outline: none; border-color: #569cd6;
        }
        
        .button-row {
          display: flex; gap: 8px; flex-wrap: wrap;
        }
        
        button {
          background: #569cd6; color: #fff; border: none; padding: 6px 12px;
          border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;
        }
        
        button:hover { background: #4682b4; }
        button:disabled { background: #444; cursor: not-allowed; }
        
        .send-btn { background: #0e639c; }
        .send-btn:hover { background: #1177bb; }
        
        .secondary-btn { background: #444; }
        .secondary-btn:hover { background: #555; }
        
        /* Code block styles */
        .code-block {
          background: #1e1e1e; border: 1px solid #444; border-radius: 4px;
          margin: 8px 0; overflow-x: auto;
        }
        .code-header {
          background: #2d2d30; color: #569cd6; padding: 4px 8px;
          font-size: 11px; font-weight: 500; border-bottom: 1px solid #444;
        }
        .code-content {
          padding: 8px; margin: 0; font-family: 'Courier New', monospace;
          font-size: 12px; line-height: 1.4; background: transparent;
        }
        .inline-code {
          background: #2d2d30; color: #f78c6c; padding: 2px 4px;
          border-radius: 3px; font-family: 'Courier New', monospace;
          font-size: 12px;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="model-info">AICA • deepseek-r1:70b</div>
        <div class="token-info">
          <span>Tokens: <span id="tokenCount">0</span></span>
          <span>Cache: <span id="cacheStatus">Ready</span></span>
        </div>
      </div>
      
      <div class="chat-container" id="chat">
        ${this._formatChatHistory(history)}
      </div>
      
      <div class="input-container">
        <div class="input-wrapper">
          <textarea id="input" placeholder="Ask about code, request edits, or use commands like /read, /write, /exec..."></textarea>
          <div class="button-row">
            <button class="send-btn" onclick="sendMessage()">Send</button>
            <button class="secondary-btn" onclick="attachFile()">Attach File</button>
            <button class="secondary-btn" onclick="scanCodebase()">Scan Codebase</button>
            <button class="secondary-btn" onclick="openSettings()">Settings</button>
            <button class="secondary-btn" onclick="clearHistory()">Clear</button>
          </div>
        </div>
      </div>
      
      <script>
        const vscode = acquireVsCodeApi();
        let tokenCount = 0;
        
        // Auto-resize textarea
        const textarea = document.getElementById('input');
        textarea.addEventListener('input', function() {
          this.style.height = 'auto';
          this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });
        
        // Send on Enter (unless Shift+Enter for new line)
        textarea.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
          }
          // Ctrl/Cmd+Enter also sends (for compatibility)
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            sendMessage();
          }
        });
        
        function sendMessage() {
          const input = document.getElementById('input');
          const text = input.value.trim();
          if (!text) return;
          
          // Add user message to chat
          addMessage('user', text);
          
          // Update token count (rough estimate)
          tokenCount += text.split(' ').length;
          document.getElementById('tokenCount').textContent = tokenCount;
          
          vscode.postMessage({ command: 'sendMessage', text: text });
          input.value = '';
          input.style.height = 'auto';
        }
        
        function addMessage(role, content) {
          const chat = document.getElementById('chat');
          const messageDiv = document.createElement('div');
          messageDiv.className = 'message ' + role;
          
          messageDiv.innerHTML = \`
            <div class="message-header">\${role === 'user' ? 'You' : 'AICA'}</div>
            <div class="message-content">\${formatMessageContent(content)}</div>
          \`;
          
          chat.appendChild(messageDiv);
          chat.scrollTop = chat.scrollHeight;
        }
        
        function formatMessageContent(content) {
          // Simple HTML escape
          let formatted = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          
          // Simple code block formatting - just wrap in pre tags for now
          if (formatted.includes('\`\`\`')) {
            formatted = formatted.replace(/\`\`\`[\\s\\S]*?\`\`\`/g, function(match) {
              return '<pre class="code-content">' + match.replace(/\`\`\`/g, '') + '</pre>';
            });
          }
          
          // Format inline code
          formatted = formatted.replace(/\`([^\`]+)\`/g, '<code class="inline-code">$1</code>');
          
          // Convert newlines to <br>
          formatted = formatted.replace(/\\n/g, '<br>');
          
          return formatted;
        }
        
        function clearHistory() { 
          vscode.postMessage({ command: 'clearHistory' }); 
          tokenCount = 0;
          document.getElementById('tokenCount').textContent = '0';
        }
        function scanCodebase() { vscode.postMessage({ command: 'scanCodebase' }); }
        function attachFile() { vscode.postMessage({ command: 'attachFile' }); }
        function openSettings() { vscode.postMessage({ command: 'openSettings' }); }
        
        let currentStreamingMessage = null;
        
        window.addEventListener('message', event => {
          const msg = event.data;
          
          if (msg.command === 'startStreaming') {
            // Create a new streaming message
            const chat = document.getElementById('chat');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message assistant';
            messageDiv.innerHTML = \`
              <div class="message-header">AICA</div>
              <div class="message-content"></div>
            \`;
            chat.appendChild(messageDiv);
            currentStreamingMessage = messageDiv.querySelector('.message-content');
            chat.scrollTop = chat.scrollHeight;
            document.getElementById('cacheStatus').textContent = 'Thinking...';
          }
          
          if (msg.command === 'streamingUpdate') {
            if (currentStreamingMessage) {
              currentStreamingMessage.innerHTML = msg.fullContent.replace(/</g, '&lt;').replace(/>/g, '&gt;');
              document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
            }
          }
          
          if (msg.command === 'streamingComplete') {
            if (currentStreamingMessage) {
              tokenCount += currentStreamingMessage.textContent.split(' ').length;
              document.getElementById('tokenCount').textContent = tokenCount;
            }
            currentStreamingMessage = null;
            document.getElementById('cacheStatus').textContent = 'Ready';
          }
          
          if (msg.command === 'appendMessage') {
            addMessage('assistant', msg.content);
            // Update token count for response
            tokenCount += msg.content.split(' ').length;
            document.getElementById('tokenCount').textContent = tokenCount;
          }
          
          if (msg.command === 'clearChat') {
            document.getElementById('chat').innerHTML = '';
            currentStreamingMessage = null;
          }
          
          if (msg.command === 'updateTokens') {
            document.getElementById('tokenCount').textContent = msg.tokens;
            tokenCount = msg.tokens;
          }
          
          if (msg.command === 'updateCache') {
            document.getElementById('cacheStatus').textContent = msg.status;
          }
        });
      </script>
    </body>
    </html>`;
  }

  private _formatChatHistory(history: string): string {
    if (!history.trim()) return '';
    
    const lines = history.split('\n');
    let formatted = '';
    let currentRole = '';
    let currentContent = '';
    
    for (const line of lines) {
      if (line.startsWith('User: ')) {
        if (currentContent) {
          formatted += this._createMessageHTML(currentRole, currentContent);
        }
        currentRole = 'user';
        currentContent = line.substring(6);
      } else if (line.startsWith('AICA: ')) {
        if (currentContent) {
          formatted += this._createMessageHTML(currentRole, currentContent);
        }
        currentRole = 'assistant';
        currentContent = line.substring(6);
      } else if (currentContent) {
        currentContent += '\n' + line;
      }
    }
    
    if (currentContent) {
      formatted += this._createMessageHTML(currentRole, currentContent);
    }
    
    return formatted;
  }

  private _createMessageHTML(role: string, content: string): string {
    const displayRole = role === 'user' ? 'You' : 'AICA';
    const escapedContent = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <div class="message ${role}">
        <div class="message-header">${displayRole}</div>
        <div class="message-content">${escapedContent}</div>
      </div>
    `;
  }

  private async _parseAndHandleCodeSuggestions(response: string): Promise<void> {
    // Parse AI response for suggested code changes
    const suggestionPattern = /\*\*SUGGESTED CHANGES FOR (.+?):\*\*\s*(.*?)\s*```(\w+)?\s*([\s\S]*?)```/gi;
    let match;
    
    while ((match = suggestionPattern.exec(response)) !== null) {
      const filename = match[1].trim();
      const description = match[2].trim();
      const language = match[3] || '';
      const newCode = match[4].trim();
      
      try {
        // Try to find the file in the workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          continue;
        }
        
        // Search for the file
        const files = await vscode.workspace.findFiles(`**/${filename}`, '**/node_modules/**', 1);
        if (files.length === 0) {
          // File not found, skip this suggestion
          continue;
        }
        
        const filePath = files[0].fsPath;
        const doc = await vscode.workspace.openTextDocument(files[0]);
        const originalCode = doc.getText();
        
        // Trigger the preview functionality
        await previewCodeChange(originalCode, newCode, filePath, description);
        
      } catch (error) {
        console.error('Error handling code suggestion:', error);
        // Continue with other suggestions if one fails
        continue;
      }
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Register Sidebar chat view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AicaChatViewProvider.viewType, new AicaChatViewProvider(context.extensionUri))
  );

  // Command: Review current file
  let reviewFile = vscode.commands.registerCommand('aica.reviewFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor!');
      return;
    }

    const doc = editor.document;
    const code = doc.getText();
    const review = await getOllamaReview(code, 'Review this file for bugs, style issues, and improvements.');
    showReviewInWebview(review, `AICA Review: ${path.basename(doc.fileName)}`);
  });

  // Command: Review selected code
  let reviewSelection = vscode.commands.registerCommand('aica.reviewSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor!');
      return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showErrorMessage('Select some code first!');
      return;
    }

    const code = editor.document.getText(selection);
    const review = await getOllamaReview(code, 'Review this code snippet for issues and suggestions.');
    showReviewInWebview(review, 'AICA Review: Selection');
  });

  // Command: Review workspace
  let reviewWorkspace = vscode.commands.registerCommand('aica.reviewWorkspace', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('Open a workspace first!');
      return;
    }

    let context = 'Review this codebase:\n';
    const files = await vscode.workspace.findFiles(
      '**/*.{ts,js,py,rs,go,jsx,tsx,cpp,c,java}',
      '**/node_modules/**',
      10
    );
    for (const file of files.slice(0, 5)) {
      const doc = await vscode.workspace.openTextDocument(file);
      const content = doc.getText().substring(0, 1000);
      context += `\n--- ${file.fsPath} ---\n${content}\n`;
    }
    const review = await getOllamaReview(context, 'Provide an overall codebase review: structure, potential issues, and refactoring suggestions.');
    showReviewInWebview(review, 'AICA Review: Workspace');
  });

  // Command: Attach file to context
  let attachFile = vscode.commands.registerCommand('aica.attachFile', async () => {
    const uri = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false });
    if (uri && uri[0]) {
      const doc = await vscode.workspace.openTextDocument(uri[0]);
      const content = doc.getText().substring(0, 2000);
      chatHistory.push(`Attached: ${uri[0].fsPath}\n${content}`);
      vscode.window.showInformationMessage(`Attached ${path.basename(uri[0].fsPath)} to AICA context.`);
    }
  });

  // Command: Scan codebase
  let scanCodebase = vscode.commands.registerCommand('aica.scanCodebase', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('Open a workspace first!');
      return;
    }

    let index = 'Codebase Index:\n';
    const files = await vscode.workspace.findFiles('**/*.{ts,js,py,rs,go,jsx,tsx,cpp,c,java}', '**/node_modules/**', 20);
    for (const file of files.slice(0, 10)) {
      const doc = await vscode.workspace.openTextDocument(file);
      const summary = doc.getText().substring(0, 500);
      index += `\n--- ${file.fsPath} ---\n${summary}...\n`;
    }
    chatHistory.push(index);
    vscode.window.showInformationMessage('Codebase indexed and added to AICA context.');
  });

  // Command: Apply suggested edit
  let applyEdit = vscode.commands.registerCommand('aica.applyEdit', async () => {
    const diff = await vscode.window.showInputBox({ prompt: 'Paste AI-suggested diff:' });
    const filePath = await vscode.window.showInputBox({ prompt: 'Target file path:' });
    if (diff && filePath) {
      await applyCodeEdit(diff, filePath);
    }
  });

  // Command: Open Settings
  let openSettings = vscode.commands.registerCommand('aica.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'aica');
  });

  context.subscriptions.push(reviewFile, reviewSelection, reviewWorkspace, attachFile, scanCodebase, applyEdit, openSettings);
}

// Ollama API: Single-shot review (/api/generate)
async function getOllamaReview(code: string, instruction: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('aica');
  const model = config.get<string>('model', 'codellama');
  const apiUrl = config.get<string>('apiUrl', 'http://localhost:11434');

  if (!apiUrl.startsWith('http')) {
    vscode.window.showWarningMessage(`AICA: Invalid apiUrl '${apiUrl}'. Use http://<IP>:<port>`);
    return 'Invalid Ollama URL.';
  }

  try {
    const prompt = `${instruction}\n\nCode:\n${code}`;
    const response = await axios.default.post(`${apiUrl}/api/generate`, {
      model,
      prompt,
      stream: false,
      options: { temperature: 0.2 }
    });
    return response.data.response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`AICA: Ollama error - ${message}`);
    return 'Error connecting to Ollama. Ensure the server is running at ' + apiUrl;
  }
}

// Ollama API: Chat for multi-turn with streaming
async function getOllamaChat(prompt: string, webview?: vscode.Webview): Promise<string> {
  const config = vscode.workspace.getConfiguration('aica');
  const model = config.get<string>('model', 'codellama');
  const apiUrl = config.get<string>('apiUrl', 'http://localhost:11434');

  if (!apiUrl.startsWith('http')) {
    vscode.window.showWarningMessage(`AICA: Invalid apiUrl '${apiUrl}'. Use http://<IP>:<port>`);
    return 'Invalid Ollama URL.';
  }

  try {
    const response = await axios.default.post(`${apiUrl}/api/chat`, {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      options: { temperature: 0.2 }
    }, {
      responseType: 'stream'
    });

    let fullResponse = '';
    
    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.message && data.message.content) {
              const content = data.message.content;
              fullResponse += content;
              
              // Send streaming update to webview
              if (webview) {
                webview.postMessage({ 
                  command: 'streamingUpdate', 
                  content: content,
                  fullContent: fullResponse 
                });
              }
            }
            
            if (data.done) {
              resolve(fullResponse);
            }
          } catch (parseError) {
            // Ignore JSON parse errors for partial chunks
          }
        }
      });

      response.data.on('end', () => {
        if (webview) {
          webview.postMessage({ command: 'streamingComplete' });
        }
        resolve(fullResponse);
      });

      response.data.on('error', (error: Error) => {
        reject(error);
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`AICA: Ollama error - ${message}`);
    return 'Error connecting to Ollama.';
  }
}

// New function for previewing code changes (similar to Cline)
async function previewCodeChange(originalCode: string, newCode: string, filePath: string, description: string) {
  try {
    // Show side-by-side diff preview
    const shouldApply = await showSideBySideDiffPreview(originalCode, newCode, filePath, description);
    
    if (shouldApply) {
      const uri = vscode.Uri.file(filePath);
      const edit = new vscode.WorkspaceEdit();
      
      // Replace entire file content with new code
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
      edit.replace(uri, fullRange, newCode);
      
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`Applied changes to ${path.basename(filePath)}`);
    } else {
      vscode.window.showInformationMessage('Changes cancelled');
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Preview failed: ${error}`);
  }
}

// Enhanced diff handling with preview
async function applyCodeEdit(diffText: string, filePath: string) {
  try {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const originalContent = doc.getText();
    
    // Parse the diff and apply changes
    const newContent = applyDiffToContent(originalContent, diffText);
    
    // Show diff preview
    const shouldApply = await showDiffPreview(originalContent, newContent, filePath);
    
    if (shouldApply) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), newContent);
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`Applied edit to ${filePath}`);
    } else {
      vscode.window.showInformationMessage('Edit cancelled');
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Edit failed: ${error}`);
  }
}

// Apply diff to content using proper diff parsing
function applyDiffToContent(originalContent: string, diffText: string): string {
  const lines = originalContent.split('\n');
  const diffLines = diffText.split('\n');
  
  // Simple unified diff parser
  let result = [...lines];
  let lineOffset = 0;
  
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -start,count +start,count @@
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        lineOffset = parseInt(match[1]) - 1; // Convert to 0-based index
      }
    } else if (line.startsWith('-')) {
      // Remove line
      const content = line.substring(1);
      const index = result.findIndex((l, idx) => idx >= lineOffset && l === content);
      if (index !== -1) {
        result.splice(index, 1);
      }
    } else if (line.startsWith('+')) {
      // Add line
      const content = line.substring(1);
      result.splice(lineOffset, 0, content);
      lineOffset++;
    }
  }
  
  return result.join('\n');
}

// Helper function to escape HTML
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Show side-by-side diff preview (Cline-style)
async function showSideBySideDiffPreview(original: string, modified: string, filePath: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'aicaSideBySideDiff',
      `Code Changes: ${path.basename(filePath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = getSideBySideDiffWebviewContent(original, modified, filePath, description);
    
    panel.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'apply':
          panel.dispose();
          resolve(true);
          break;
        case 'cancel':
          panel.dispose();
          resolve(false);
          break;
      }
    });
    
    panel.onDidDispose(() => {
      resolve(false);
    });
  });
}

// Show diff preview in a webview
async function showDiffPreview(original: string, modified: string, filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      'aicaDiffPreview',
      `Diff Preview: ${path.basename(filePath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const diffResult = diff.createPatch(filePath, original, modified);
    
    panel.webview.html = getDiffPreviewWebviewContent(diffResult, filePath);
    
    panel.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'apply':
          panel.dispose();
          resolve(true);
          break;
        case 'cancel':
          panel.dispose();
          resolve(false);
          break;
      }
    });
    
    panel.onDidDispose(() => {
      resolve(false);
    });
  });
}

// Side-by-side diff preview webview HTML (Cline-style)
function getSideBySideDiffWebviewContent(original: string, modified: string, filePath: string, description: string): string {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');
  const maxLines = Math.max(originalLines.length, modifiedLines.length);
  
  let sideBySideContent = '';
  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] || '';
    const modifiedLine = modifiedLines[i] || '';
    const lineNum = i + 1;
    
    // Determine if lines are different
    const isDifferent = originalLine !== modifiedLine;
    const rowClass = isDifferent ? 'diff-row changed' : 'diff-row';
    
    sideBySideContent += `
      <tr class="${rowClass}">
        <td class="line-number">${lineNum}</td>
        <td class="code-cell original">${escapeHtml(originalLine)}</td>
        <td class="line-number">${lineNum}</td>
        <td class="code-cell modified">${escapeHtml(modifiedLine)}</td>
      </tr>
    `;
  }
  
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Code Changes Preview</title>
    <style>
      body { 
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 20px; 
        background: #1e1e1e; 
        color: #d4d4d4; 
        margin: 0;
      }
      h1 { 
        color: #569cd6; 
        margin-bottom: 10px; 
        font-size: 24px;
      }
      .description {
        background: #252526;
        border: 1px solid #444;
        border-radius: 4px;
        padding: 12px;
        margin-bottom: 20px;
        color: #cccccc;
        font-style: italic;
      }
      .diff-container {
        background: #252526;
        border: 1px solid #444;
        border-radius: 4px;
        margin-bottom: 20px;
        overflow: auto;
        max-height: 70vh;
      }
      .diff-table {
        width: 100%;
        border-collapse: collapse;
        font-family: 'Courier New', monospace;
        font-size: 13px;
      }
      .diff-header {
        background: #2d2d30;
        border-bottom: 1px solid #444;
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .diff-header th {
        padding: 8px 12px;
        text-align: left;
        font-weight: 600;
        color: #569cd6;
        border-right: 1px solid #444;
      }
      .diff-row {
        border-bottom: 1px solid #333;
      }
      .diff-row.changed {
        background: rgba(255, 193, 7, 0.1);
      }
      .line-number {
        width: 50px;
        padding: 4px 8px;
        text-align: right;
        color: #858585;
        background: #2d2d30;
        border-right: 1px solid #444;
        user-select: none;
        vertical-align: top;
      }
      .code-cell {
        padding: 4px 12px;
        white-space: pre;
        vertical-align: top;
        border-right: 1px solid #444;
        min-width: 0;
        word-wrap: break-word;
      }
      .code-cell.original {
        background: rgba(248, 81, 73, 0.1);
      }
      .code-cell.modified {
        background: rgba(46, 160, 67, 0.1);
      }
      .diff-row.changed .code-cell.original {
        background: rgba(248, 81, 73, 0.2);
      }
      .diff-row.changed .code-cell.modified {
        background: rgba(46, 160, 67, 0.2);
      }
      .button-container {
        display: flex;
        gap: 12px;
        justify-content: center;
        padding: 20px 0;
      }
      button {
        padding: 12px 24px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        font-size: 14px;
        transition: background-color 0.2s;
      }
      .apply-btn {
        background: #0e639c;
        color: white;
      }
      .apply-btn:hover {
        background: #1177bb;
      }
      .cancel-btn {
        background: #444;
        color: white;
      }
      .cancel-btn:hover {
        background: #555;
      }
    </style>
  </head>
  <body>
    <h1>Preview Changes: ${path.basename(filePath)}</h1>
    ${description ? `<div class="description">${escapeHtml(description)}</div>` : ''}
    
    <div class="diff-container">
      <table class="diff-table">
        <thead class="diff-header">
          <tr>
            <th style="width: 50px;">#</th>
            <th style="width: 50%;">Original</th>
            <th style="width: 50px;">#</th>
            <th style="width: 50%;">Modified</th>
          </tr>
        </thead>
        <tbody>
          ${sideBySideContent}
        </tbody>
      </table>
    </div>
    
    <div class="button-container">
      <button class="apply-btn" onclick="applyChanges()">Apply Changes</button>
      <button class="cancel-btn" onclick="cancelChanges()">Cancel</button>
    </div>
    
    <script>
      const vscode = acquireVsCodeApi();
      
      function applyChanges() {
        vscode.postMessage({ command: 'apply' });
      }
      
      function cancelChanges() {
        vscode.postMessage({ command: 'cancel' });
      }
    </script>
  </body>
  </html>`;
}

// Diff preview webview HTML
function getDiffPreviewWebviewContent(diffText: string, filePath: string): string {
  const escapedDiff = diffText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Diff Preview</title>
    <style>
      body { 
        font-family: 'Courier New', monospace; 
        padding: 20px; 
        background: #1e1e1e; 
        color: #d4d4d4; 
        margin: 0;
      }
      h1 { color: #569cd6; margin-bottom: 20px; }
      .diff-container {
        background: #252526;
        border: 1px solid #444;
        border-radius: 4px;
        padding: 15px;
        margin-bottom: 20px;
        overflow-x: auto;
      }
      .diff-line {
        margin: 0;
        padding: 2px 0;
        white-space: pre;
      }
      .diff-add { background: #1e4f1e; color: #4ec9b0; }
      .diff-remove { background: #4f1e1e; color: #f48771; }
      .diff-context { color: #d4d4d4; }
      .diff-header { color: #569cd6; font-weight: bold; }
      .button-container {
        display: flex;
        gap: 10px;
        justify-content: center;
      }
      button {
        padding: 10px 20px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
      }
      .apply-btn {
        background: #0e639c;
        color: white;
      }
      .apply-btn:hover {
        background: #1177bb;
      }
      .cancel-btn {
        background: #444;
        color: white;
      }
      .cancel-btn:hover {
        background: #555;
      }
    </style>
  </head>
  <body>
    <h1>Preview Changes: ${path.basename(filePath)}</h1>
    <div class="diff-container">
      <pre>${formatDiffForDisplay(escapedDiff)}</pre>
    </div>
    <div class="button-container">
      <button class="apply-btn" onclick="applyChanges()">Apply Changes</button>
      <button class="cancel-btn" onclick="cancelChanges()">Cancel</button>
    </div>
    
    <script>
      const vscode = acquireVsCodeApi();
      
      function applyChanges() {
        vscode.postMessage({ command: 'apply' });
      }
      
      function cancelChanges() {
        vscode.postMessage({ command: 'cancel' });
      }
    </script>
  </body>
  </html>`;
}

// Format diff for better display
function formatDiffForDisplay(diffText: string): string {
  return diffText.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      return `<div class="diff-line diff-header">${line}</div>`;
    } else if (line.startsWith('+')) {
      return `<div class="diff-line diff-add">${line}</div>`;
    } else if (line.startsWith('-')) {
      return `<div class="diff-line diff-remove">${line}</div>`;
    } else {
      return `<div class="diff-line diff-context">${line}</div>`;
    }
  }).join('');
}

// Display review in a webview
function showReviewInWebview(review: string, title: string) {
  const panel = vscode.window.createWebviewPanel(
    'aicaReview',
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );
  panel.webview.html = getReviewWebviewContent(review);
}

// Review webview HTML
function getReviewWebviewContent(review: string): string {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>AICA Review</title>
    <style>
      body { font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
      h1 { color: #569cd6; }
      pre { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>AICA Code Review</h1>
    <pre>${review.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
  </body>
  </html>`;
}

export function deactivate() {
  chatHistory = []; // Clear on deactivate if not persisting
}
