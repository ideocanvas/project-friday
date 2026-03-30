#!/bin/bash
# Start Chrome/Edge with remote debugging for Friday browser skill
# This keeps the browser running persistently so the browser skill can connect to it

CHROME_PROFILE_DIR="./skills/builtin/browser/chrome-profile/default"

# Create profile directory if it doesn't exist
mkdir -p "$CHROME_PROFILE_DIR"

# Check if browser is already running with debugging port
if lsof -i :9222 > /dev/null 2>&1; then
    echo "Browser is already running with debugging port 9222"
    exit 0
fi

# Try Google Chrome first, then Microsoft Edge, then Chromium
BROWSER_PATH=""
BROWSER_NAME=""

if [ -d "/Applications/Google Chrome.app" ]; then
    BROWSER_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    BROWSER_NAME="Google Chrome"
elif [ -d "/Applications/Microsoft Edge.app" ]; then
    BROWSER_PATH="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    BROWSER_NAME="Microsoft Edge"
elif [ -d "/Applications/Chromium.app" ]; then
    BROWSER_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"
    BROWSER_NAME="Chromium"
fi

if [ -z "$BROWSER_PATH" ]; then
    echo "ERROR: No supported browser found"
    echo "Please install Google Chrome, Microsoft Edge, or Chromium"
    exit 1
fi

echo "Starting $BROWSER_NAME with remote debugging..."
"$BROWSER_PATH" \
    --remote-debugging-port=9222 \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-networking \
    --disable-extensions \
    --disable-sync \
    --start-maximized \
    > /dev/null 2>&1 &

echo "$BROWSER_NAME started with PID $!"
echo "Debugging port: 9222"
echo "Profile directory: $CHROME_PROFILE_DIR"