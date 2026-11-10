#!/usr/bin/env bash
#
# Helper script. Does the two things you would otherwise click through:
#   1. enables the LoRa add-on on both Shelly devices and reboots them
#   2. makes one shared secret key and prints it, ready to paste into the script
#
# It does NOT touch the radio - lora-gateway.shelly.js does that itself when you
# start it on the device.
#
# Usage:
#   ./provision.sh <gateway-ip> <node-ip>
#
# Example:
#   ./provision.sh 192.168.1.50 192.168.1.51
#
# On Windows, or if you would rather not bother, skip this. README.md has an
# "Option B" that goes entirely through the web interface.

set -u

GATEWAY_IP="${1:-}"
NODE_IP="${2:-}"
KEY_FILE="$(dirname "$0")/lora-key.txt"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ -z "$GATEWAY_IP" ] || [ -z "$NODE_IP" ]; then
  red "Two IP addresses are required."
  echo "Usage:   $0 <gateway-ip> <node-ip>"
  echo "Example: $0 192.168.1.50 192.168.1.51"
  exit 1
fi

for cmd in curl python3 openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    red "'$cmd' is not installed. Install it and try again."
    exit 1
  fi
done

# One RPC call, retried up to 4 times: a Shelly's web server accepts very few
# concurrent connections and may simply not answer the first time.
rpc() {
  local ip="$1" method="$2" params="${3:-}" body attempt out
  if [ -n "$params" ]; then
    body="{\"id\":1,\"method\":\"$method\",\"params\":$params}"
  else
    body="{\"id\":1,\"method\":\"$method\"}"
  fi
  for attempt in 1 2 3 4; do
    out=$(curl -s -m 20 -X POST "http://$ip/rpc" \
            -H 'Content-Type: application/json' -d "$body" 2>/dev/null)
    if [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
    sleep 2
  done
  return 1
}

# Pulls one field out of a JSON reply, e.g. result.device.addon_type
jget() {
  python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
for k in sys.argv[1].split('.'):
    if isinstance(d,dict) and k in d: d=d[k]
    else: print(''); sys.exit()
print(d)
" "$1"
}

wait_for() {
  local ip="$1" i
  for i in $(seq 1 40); do
    curl -s -m 3 "http://$ip/rpc/RPC.Ping" >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

# --- are they reachable? -----------------------------------------------------
step "Checking that both Shelly devices answer"
for ip in "$GATEWAY_IP" "$NODE_IP"; do
  model=$(rpc "$ip" Shelly.GetDeviceInfo | jget result.model)
  if [ -z "$model" ]; then
    red "$ip does not answer. Check the IP address and that the device is on the network."
    exit 1
  fi
  green "  $ip -> $model"
done

# --- enable the add-on -------------------------------------------------------
step "Enabling the LoRa add-on"
rebooted=0
for ip in "$GATEWAY_IP" "$NODE_IP"; do
  current=$(rpc "$ip" Sys.GetConfig | jget result.device.addon_type)
  if [ "$current" = "LoRa" ]; then
    green "  $ip -> already enabled"
    continue
  fi
  rpc "$ip" Sys.SetConfig '{"config":{"device":{"addon_type":"lora"}}}' >/dev/null
  rpc "$ip" Shelly.Reboot >/dev/null
  echo "  $ip -> enabled, rebooting..."
  rebooted=1
done

if [ "$rebooted" = "1" ]; then
  step "Waiting for the devices to come back"
  for ip in "$GATEWAY_IP" "$NODE_IP"; do
    if wait_for "$ip"; then
      green "  $ip -> up"
    else
      red "  $ip did not come back. Power cycle it and run this again."
      exit 1
    fi
  done
fi

# --- is the add-on recognised? -----------------------------------------------
step "Checking that the add-on is recognised"
for ip in "$GATEWAY_IP" "$NODE_IP"; do
  info=$(rpc "$ip" AddOn.GetInfo)
  if [ "$(printf '%s' "$info" | jget result.type)" != "LoRa" ]; then
    red "  $ip -> the add-on is not visible."
    red "       Switch the power off, press the add-on in all the way, power up again."
    exit 1
  fi
  green "  $ip -> LoRa add-on, firmware $(printf '%s' "$info" | jget result.fw_ver)"
done

# --- the secret key ----------------------------------------------------------
step "Secret key"
if [ -f "$KEY_FILE" ]; then
  KEY=$(cat "$KEY_FILE")
  green "  using the existing one from $KEY_FILE"
else
  KEY=$(openssl rand -base64 16)
  printf '%s' "$KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  green "  new key, saved to $KEY_FILE"
fi

step "Done - now go to step 5 in README.md"
cat <<EOF

Copy this line into the script, on BOTH devices:

  key: '$KEY',

The rest of the script:

  on the GATEWAY ($GATEWAY_IP)   role: 'gateway',   myAddr: '00010001',   peerAddr: '00010002',
  on the NODE    ($NODE_IP)   role: 'node',      myAddr: '00010002',   peerAddr: '00010001',

The radio configures itself when you start the script. Change nothing else.
EOF
