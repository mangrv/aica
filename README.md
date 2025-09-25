# AICA - AI-Powered Code Assistant

A VS Code extension that provides intelligent code reviews using local or remote Ollama instances. This extension helps developers improve their code quality through AI-powered insights and recommendations.

## Features

- **Code Reviews**: Get instant feedback on your code with suggestions for improvement
- **Smart Suggestions**: AI-powered recommendations for refactoring and optimization
- **Command Integration**: Multiple commands to review files, selections, and entire workspaces
- **Chat Interface**: Interactive chat interface for discussing code changes
- **File Handling**: Attach and scan specific files or entire codebases

## Requirements

- Node.js 16+
- VS Code 1.104+
- Optional: Local Ollama instance for enhanced functionality

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Open in VS Code and start using the extension

## Extension Settings

The following settings are available:

- `aica.ollamaUrl`: URL for Ollama instance (default: http://localhost:11420)
- `aica.chatHistorySize`: Maximum number of chat messages to store
- `aica.enableStreaming`: Enable/disable streaming responses

## Activation Commands

These commands can be used to activate various features:

- `aica.reviewFile`: Review the current file
- `aica.reviewSelection`: Review selected code
- `aica.reviewWorkspace`: Review entire workspace
- `aica.attachFile`: Attach a specific file for analysis
- `aica.scanCodebase`: Scan the entire codebase
- `aica.applyEdit`: Apply suggested edits

## Contributing

1. Fork this repository
2. Create a feature branch: `git checkout -b feature-name`
3. Commit your changes: `git commit -m "description"`
4. Push to the branch: `git push origin feature-name`
5. Open a Pull Request

Please ensure all contributions follow standard professional guidelines and include appropriate test cases.

## Acknowledgments

This extension was built using:
- VS Code Extension API
- Ollama for code analysis
- Webpack for bundling
- TypeScript for type safety

## License

MIT License - see LICENSE file for details.