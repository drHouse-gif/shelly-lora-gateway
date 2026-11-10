#!/usr/bin/env bash
#
# Помощен скрипт. Прави две неща, които иначе се цъкат на ръка:
#   1. включва LoRa аддона на двата Shelly и ги рестартира
#   2. прави един общ таен ключ и ти го показва, за да го сложиш в скрипта
#
# НЕ пипа радиото - това го прави самият скрипт lora-gateway.shelly.js,
# когато го пуснеш на устройството.
#
# Употреба:
#   ./provision.sh <IP-на-гейта> <IP-на-възела>
#
# Пример:
#   ./provision.sh 192.168.1.50 192.168.1.51
#
# Ако си на Windows или не ти се занимава - прескочи го. В README.md има
# "Вариант Б", който минава само през уеб интерфейса.

set -u

GATEWAY_IP="${1:-}"
NODE_IP="${2:-}"
KEY_FILE="$(dirname "$0")/lora-key.txt"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ -z "$GATEWAY_IP" ] || [ -z "$NODE_IP" ]; then
  red "Трябват два IP адреса."
  echo "Употреба: $0 <IP-на-гейта> <IP-на-възела>"
  echo "Пример:   $0 192.168.1.50 192.168.1.51"
  exit 1
fi

for cmd in curl python3 openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    red "Липсва програмата '$cmd'. Инсталирай я и пробвай пак."
    exit 1
  fi
done

# Вика един RPC метод. Опитва до 4 пъти, защото web сървърът на Shelly
# приема много малко едновременни връзки и спокойно може да не отговори.
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

# Вади едно поле от JSON отговор, например result.device.addon_type
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

# --- проверка на връзката ----------------------------------------------------
step "Проверявам дали двата Shelly отговарят"
for ip in "$GATEWAY_IP" "$NODE_IP"; do
  model=$(rpc "$ip" Shelly.GetDeviceInfo | jget result.model)
  if [ -z "$model" ]; then
    red "$ip не отговаря. Провери IP адреса и дали устройството е в мрежата."
    exit 1
  fi
  green "  $ip -> $model"
done

# --- включване на аддона -----------------------------------------------------
step "Включвам LoRa аддона"
rebooted=0
for ip in "$GATEWAY_IP" "$NODE_IP"; do
  current=$(rpc "$ip" Sys.GetConfig | jget result.device.addon_type)
  if [ "$current" = "LoRa" ]; then
    green "  $ip -> вече е включен"
    continue
  fi
  rpc "$ip" Sys.SetConfig '{"config":{"device":{"addon_type":"lora"}}}' >/dev/null
  rpc "$ip" Shelly.Reboot >/dev/null
  echo "  $ip -> включен, рестартирам..."
  rebooted=1
done

if [ "$rebooted" = "1" ]; then
  step "Чакам устройствата да се вдигнат"
  for ip in "$GATEWAY_IP" "$NODE_IP"; do
    if wait_for "$ip"; then
      green "  $ip -> готов"
    else
      red "  $ip не се върна. Изключи и пусни захранването, после пробвай пак."
      exit 1
    fi
  done
fi

# --- аддонът вижда ли се? ----------------------------------------------------
step "Проверявам, че аддонът се разпознава"
for ip in "$GATEWAY_IP" "$NODE_IP"; do
  info=$(rpc "$ip" AddOn.GetInfo)
  if [ "$(printf '%s' "$info" | jget result.type)" != "LoRa" ]; then
    red "  $ip -> аддонът не се вижда."
    red "       Изключи захранването, натисни аддона докрай, пусни пак."
    exit 1
  fi
  green "  $ip -> LoRa аддон, фърмуер $(printf '%s' "$info" | jget result.fw_ver)"
done

# --- таен ключ ---------------------------------------------------------------
step "Таен ключ"
if [ -f "$KEY_FILE" ]; then
  KEY=$(cat "$KEY_FILE")
  green "  ползвам вече съществуващия от $KEY_FILE"
else
  KEY=$(openssl rand -base64 16)
  printf '%s' "$KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  green "  нов ключ, записан в $KEY_FILE"
fi

step "Готово - сега иди на стъпка 4 в README.md"
cat <<EOF

Копирай този ред и го сложи в скрипта, на ДВАТА Shelly:

  key: '$KEY',

Останалото в скрипта:

  на ГЕЙТА  ($GATEWAY_IP)   role: 'gateway',   myAddr: '00010001',   peerAddr: '00010002',
  на ВЪЗЕЛА ($NODE_IP)   role: 'node',      myAddr: '00010002',   peerAddr: '00010001',

Радиото се настройва само, когато пуснеш скрипта. Не пипай нищо друго.
EOF
