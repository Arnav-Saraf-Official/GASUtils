#!/bin/bash

# Exit on error, unset variable, pipe failure
set -euo pipefail

# Trap errors — pause so terminal stays open and user can read output
trap 'echo ""; echo "============= DEPLOYMENT FAILED ============="; echo "Press Enter to exit..."; read' ERR
# ==============================================================================
# CONFIGURATION
# Replace this with your actual Clasp Deployment ID
# ==============================================================================
DEPLOYMENT_ID="AKfycbwqo9jxBcoDenlgIgzk5Wjebfg2Gyu5W9qb6j3zvbtv10daXHPXQWfPDOC732-76v42"

echo "============= STARTING CLASP REDEPLOYMENT ============="

# 1. Push local code changes
echo "Step 1: Pushing latest code"

clasp push

# 2. Get the version description from the user
echo ""
echo "--------------------------------------------------------"
read -p "Enter a description for this new version: " VERSION_DESC
echo "--------------------------------------------------------"

# 3. Create a new immutable version and capture the output
echo ""
echo "Step 2: Creating a new script version..."
VERSION_OUTPUT=$(clasp version "$VERSION_DESC")
echo "$VERSION_OUTPUT"

# 4. Extract the version number using regex
# Matches the digit(s) in "Version X created."
if [[ $VERSION_OUTPUT =~ Created[[:space:]]+version[[:space:]]+([0-9]+) ]]; then
    VERSION_NUM="${BASH_REMATCH[1]}"
    echo "Successfully detected Version Number: $VERSION_NUM"
else
    echo "ERROR: Could not parse the version number from clasp output."
    exit 1
fi

# 5. Execute the redeployment
echo ""
echo "Step 3: Redeploying Deployment ID [$DEPLOYMENT_ID] to Version [$VERSION_NUM]..."
clasp redeploy "$DEPLOYMENT_ID" -V "$VERSION_NUM" -d "$VERSION_DESC"

echo ""
echo "============= REDEPLOYMENT COMPLETE SUCCESSFULLY ============="
echo ""
echo "Press Enter to exit..."
read