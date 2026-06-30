#!/usr/bin/env bash
set -e

# CodeWeaver installer script
# Installs CodeWeaver locally and sets up a launcher under ~/.local/bin/codeweaver

INSTALL_DIR="$HOME/.codeweaver"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/codeweaver"

echo "Installing CodeWeaver..."

# 1. Verify Node.js is installed
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run CodeWeaver. Please install Node.js (v18+) and try again." >&2
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: CodeWeaver requires Node.js v18 or higher (found v$NODE_VERSION)." >&2
  exit 1
fi

# 2. Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# 3. Download files from GitHub
REPO_RAW_URL="https://raw.githubusercontent.com/sai21-learn/claude-gemini-proxy/main"

echo "Fetching proxy scripts..."
curl -fsSL "$REPO_RAW_URL/proxy.js" -o "$INSTALL_DIR/proxy.js"
curl -fsSL "$REPO_RAW_URL/package.json" -o "$INSTALL_DIR/package.json"

# 4. Generate the runner executable script
cat << 'EOF' > "$LAUNCHER"
#!/usr/bin/env node
const path = require('path');
const home = process.env.HOME || process.env.USERPROFILE || '';
const proxyPath = path.join(home, '.codeweaver', 'proxy.js');
require(proxyPath);
EOF

# 5. Make it executable
chmod +x "$LAUNCHER"

echo "CodeWeaver has been successfully installed!"
echo ""
echo "Installation Directory: $INSTALL_DIR"
echo "Executable Launcher:    $LAUNCHER"
echo ""
echo "Please make sure that $BIN_DIR is added to your system PATH."
echo "You can check or add it to your shell configuration file (e.g., ~/.bashrc, ~/.zshrc):"
echo "  export PATH=\$PATH:\$HOME/.local/bin"
echo ""
echo "To get started:"
echo "1. Run:  codeweaver --login"
echo "2. Run:  codeweaver"
echo "3. Run:  claude"
