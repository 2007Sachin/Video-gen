#!/bin/bash
# Push to GitHub and trigger render workflow
# Usage: ./push-and-render.sh [github-username/repo-name]

set -e

REPO="${1:-YOUR_USERNAME/fde-video-factory}"
DIR="C:/Users/sachi/AppData/Local/Temp/fde-intro-composition"

echo "📦 Preparing repository: $REPO"
cd "$DIR"

# Initialize git if needed
if [ ! -d .git ]; then
  git init
  git checkout -b main
fi

# Add all files
git add .
git commit -m "FDE course intro: bang-motion composition + GitHub Actions render" 2>/dev/null || echo "No changes to commit"

# Add remote if not exists
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/$REPO.git"
fi

# Push
echo "🚀 Pushing to GitHub..."
git push -u origin main --force

echo ""
echo "✅ Pushed! Now trigger the render:"
echo "   1. Go to: https://github.com/$REPO/actions/workflows/render.yml"
echo "   2. Click 'Run workflow' → Choose settings → 'Run workflow'"
echo "   3. Wait 10-20 min → Download MP4 from Artifacts"
echo ""
echo "   Or use CLI:"
echo "   gh workflow run render.yml -R $REPO -f fps=30 -f duration=305 -f quality=high"