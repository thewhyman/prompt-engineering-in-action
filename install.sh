#!/bin/bash
# Co-Dialectic installer
# Usage: curl -fsSL https://raw.githubusercontent.com/thewhyman/prompt-engineering-in-action/main/install.sh | bash

set -e

REPO="https://raw.githubusercontent.com/thewhyman/prompt-engineering-in-action/main"
SKILL_URL="$REPO/co-dialectic/SKILL.md"

echo "🧠 Co-Dialectic Installer"
echo "========================="
echo ""

# Detect platform
INSTALLED=false

# Check for Claude Code skills directory
if [ -d "$HOME/.claude" ]; then
    SKILLS_DIR="$HOME/.claude/skills/co-dialectic"
    echo "✅ Detected: Claude Code / Claude Desktop (Code tab)"
    mkdir -p "$SKILLS_DIR"
    curl -fsSL "$SKILL_URL" -o "$SKILLS_DIR/SKILL.md"
    echo "   Installed to: $SKILLS_DIR/SKILL.md"
    echo "   Type 'cod' in any Claude Code conversation to activate."
    INSTALLED=true
fi

# If nothing detected, download to current directory
if [ "$INSTALLED" = false ]; then
    echo "ℹ️  No Claude Code installation detected."
    echo "   Downloading SKILL.md to current directory..."
    mkdir -p co-dialectic
    curl -fsSL "$SKILL_URL" -o "co-dialectic/SKILL.md"
    echo ""
    echo "   Downloaded to: ./co-dialectic/SKILL.md"
    echo ""
    echo "   Next steps — paste the contents into your AI:"
    echo "   • claude.ai → Projects → Custom Instructions"
    echo "   • ChatGPT → Settings → Personalization → Custom Instructions"
    echo "   • Gemini → Profile → Personal Intelligence Instructions"
    echo "   • Any AI → paste as first message with: 'Use these instructions:'"
fi

echo ""
echo "🎉 Done! Start a conversation and type 'cod' to activate."
echo "   Updates: https://github.com/thewhyman/prompt-engineering-in-action"
echo ""
