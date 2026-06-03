# This script is for x86/x64 devices. It will install Bandix, 06.02.2026.
#!/bin/sh

# Configuration
URL="https://github.com/timsaya/openwrt-bandix/releases/download/v0.12.9/bandix-0.12.9-r1_x86_64.apk"
FILE_NAME="bandix-0.12.9-r1_x86_64.apk"
TEMP_DIR="/tmp/bandix_install"

echo "=== Starting Bandix Installation ==="

# 1. Update OpenWrt package lists to handle dependencies
echo "Updating local package index..."
apk update

# 2. Create local temp directory (OpenWrt's /tmp lives in RAM to save flash wear)
mkdir -p "$TEMP_DIR"
cd "$TEMP_DIR"

# 3. Download the APK file
echo "Downloading $FILE_NAME..."
if command -v wget >/dev/null 2>&1; then
    wget -O "$FILE_NAME" "$URL"
elif command -v curl >/dev/null 2>&1; then
    curl -L -o "$FILE_NAME" "$URL"
else
    echo "Error: Neither wget nor curl is installed. Cannot download file." >&2
    exit 1
fi

# 4. Install using the untrusted signature override flag
echo "Installing package..."
apk add --allow-untrusted "./$FILE_NAME"

# 5. Clean up temporary files
echo "Cleaning up..."
rm -f "./$FILE_NAME"
cd / && rm -rf "$TEMP_DIR"

echo "=== Bandix Installed Successfully! ==="
