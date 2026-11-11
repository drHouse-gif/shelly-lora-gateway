# Shelly over LoRa - controlling a device with no network

Two Shelly devices talk to each other over radio, with no WiFi between them.

One device sits where there is a network. The other sits where there is none -
the cellar, the barn, the next building - and **its WiFi is switched off on
purpose**. The link between them is LoRa radio.

The one on the network shows the other one at itself: the far device's current,
voltage, temperature and switch appear as its own sensors. Whatever already
reads the first Shelly - Home Assistant, the Shelly app, MQTT, anything - sees
the second one through it, with no extra work.

You need **one file**, put on both Shelly devices. Nothing is installed on a
computer.

> На български: [README.bg.md](README.bg.md)

---

## ⚠ Read this first

These devices are wired to **230 V**. If you have never replaced a wall socket
yourself, do not start here - have an electrician do the wiring, then come back
for the software part.

- Always **switch off the breaker** before touching a wire.
- During setup, **connect nothing to the relay**. Let it click on nothing.
- The LoRa add-on goes on and comes off **only with the power off**.

---

## Six words you will meet

| word | what it means |
|---|---|
| **gateway** | The Shelly that stays on the WiFi network. It does the translating. |
| **node** | The Shelly with no network, the far one. |
| **LoRa** | Radio for long distances, but very slow. Carries small messages. |
| **add-on** | The small board that clips onto a Shelly and gives it LoRa. |
| **script** | A small program that lives inside the Shelly. This one is a single file. |
| **virtual component** | A made-up sensor or switch inside a Shelly. The gateway creates 10 of them to show the node. |

---

## What you need

- **2 Shelly devices** that support the LoRa add-on. Tested on
  **Shelly 1 PM Gen4**, firmware **2.0.0**.
- **2 Shelly LoRa Add-Ons**, with their antennas.
- A computer or phone with a browser, on the same network as both Shelly
  devices.
- 20-30 minutes.

---

## What it will look like when done

```
   [ gateway ]  --- WiFi --->  router, Home Assistant, phone
       |
       | LoRa radio, 868 MHz
       v
   [ node ]  (no WiFi, radio only)
```

The radio addresses are fixed in this guide. Do not change them until it works:

| device | its own address (`myAddr`) | the other one's address (`peerAddr`) |
|---|---|---|
| **gateway** | `00010001` | `00010002` |
| **node** | `00010002` | `00010001` |

---

## Step 1 - fitting the add-ons

1. Switch off the breaker.
2. Clip one LoRa add-on onto each Shelly. It has to go in **all the way** - you
  feel it click.
3. Screw on the antennas. **Without an antenna the radio does not work
  properly.**
4. Switch the breaker back on.

---

## Step 2 - finding the IP addresses

1. Open the **Shelly** app on your phone, or log into your router and look at
  the connected devices.
2. Look for names starting with `Shelly1PMG4-`.
3. Write both addresses down on paper. They look like `192.168.1.50`.

**Check them.** Type one of the addresses into a browser. A page with the Shelly
menu should open: `Home`, `Actions`, `Schedules`, `Add-on`, `Settings`,
`Scripts`, `Components`...

If it does not open, the address is wrong.

Now decide which is which:

- the **gateway** stays on the network
- the **node** goes far away

Write it down. You will mix them up otherwise.

---

## Step 3 - enabling the LoRa add-on

Do this on **both** devices, one at a time.

1. In the browser, open (put your own IP instead of `<IP>`):

  ```
  http://<IP>/#/addon/manage
  ```

  Or click **Add-on** in the menu on the left.

2. It says **"Manage add-on feature"** and offers three choices:
  `None`, `LoRa Add-on`, `Sensor Add-on`.
3. Pick **LoRa Add-on**.
4. Click **Save and reboot**. The device restarts; wait about half a minute.

**How to check it worked:** open

```
http://<IP>/rpc/AddOn.GetInfo
```

**What you should see:** a line of text containing `"type":"LoRa"`.

If it gives an error, switch the power off, press the add-on in harder, and try
again.

**Repeat for the other device.**

---

## Step 4 - the secret key

Both devices need **the same** secret key to understand each other. It takes 16
random bytes in base64 - a string of **24 characters ending in `==`**.

Pick a way:

- **Linux or Mac:** open a terminal and type

  ```bash
  openssl rand -base64 16
  ```

- **Windows or phone:** open <https://generate.plus/en/base64>, choose 16
  bytes, and take the result.

You get something like:

```
7Qk2Lm9pXvA1bCdEfGhIjQ==
```

**Write it down on paper.** You will put it on both devices. If you lose it,
just make a new one and repeat steps 5 and 6.

> On Linux or Mac, `provision.sh` can do steps 3 and 4 for you - see the end of
> this file.

---

## Step 5 - the script on the node

We start with the **node**, the far one.

1. Open `http://<IP-of-the-node>/#/scripts` (or **Scripts** in the menu).
2. Click **Add script**.
3. Open the file `lora-gateway.shelly.js` from this repo. Select **everything**
  (Ctrl+A), copy it (Ctrl+C), and paste it into the Shelly window (Ctrl+V).
4. Now change **four lines** near the top of the code. Press Ctrl+F in the
  window to find them:

  | find this | change it to |
  |---|---|
  | `role: 'gateway',` | `role: 'node',` |
  | `peerAddr: '00010002',` | `peerAddr: '00010001',` |
  | `myAddr: '00010001',` | `myAddr: '00010002',` |
  | `key: 'PUT-THE-SAME-KEY-ON-BOTH',` | `key: 'your key from step 4',` |

  Be careful not to delete the comma or the quotes. The key stays **inside the
  quotes**. This is what it should look like:

  ```js
  key: '7Qk2Lm9pXvA1bCdEfGhIjQ==',
  ```

5. Give the script a name, for example `lora`. Click **Save**.
6. Turn on the **Run on startup** toggle, so it starts by itself after a
  restart. **This matters** - without it, a power cut leaves the node dead.
7. Click **Start**.

**What you should see** in the black box at the bottom:

```
[LoRa] radio set: addr 00010002 SF 9
[LoRa] node up, reporting to 00010001
```

The script configures its own radio, which is why there are two lines.

If instead it says:

| message | what it means |
|---|---|
| `CONFIG.key is still the placeholder` | You did not change the key - the fourth row of the table above. |
| `no LoRa component` | Step 3 was not done on this device. |
| `radio setup failed` | The key is not 16 bytes. Make a new one. |

---

## Step 6 - the script on the gateway

The same, but on the **gateway**, and here you change **only the key**.

1. Open `http://<IP-of-the-gateway>/#/scripts` → **Add script**.
2. Paste the same `lora-gateway.shelly.js`.
3. Change **one** line only:

  | find this | change it to |
  |---|---|
  | `key: 'PUT-THE-SAME-KEY-ON-BOTH',` | `key: 'the same key',` |

  `role`, `myAddr` and `peerAddr` **stay as they are**.

4. Name it, **Save**, turn on **Run on startup**, click **Start**.

**What you should see:**

```
[LoRa] radio set: addr 00010001 SF 9
[LoRa] gateway up, mirroring 00010002
```

---

## Step 7 - check it BEFORE switching the network off

**Do not skip this step.** While both are on the network, everything is easy to
fix.

### 7.1 Did the sensors appear?

Open `http://<IP-of-the-gateway>/#/virtual` (or **Components** in the menu).

**What you should see:** 10 new things, all starting with `Node`:

| name | what it shows |
|---|---|
| Node Output | the node's switch - and you can press it from here |
| Node Link | whether there is a connection |
| Node Power | watts |
| Node Voltage | volts |
| Node Current | amps |
| Node Energy | energy used |
| Node Temperature | temperature |
| Node RSSI | how strong the signal is |
| Node SNR | how clean the signal is |
| Node Seq | a message counter |

The first message arrives within a few seconds. `Node Voltage` should show
around 230, and `Node Link` should be on.

### 7.2 Does the control work?

Press **Node Output**.

**What you should see:** the relay on the **node** clicks after about 2 seconds,
and `Node Seq` goes up. Press it again and it goes back.

### 7.3 Is the signal good enough?

Look at **Node RSSI**:

| RSSI | meaning |
|---|---|
| -30 to -90 | very good |
| -90 to -110 | works, but marginal |
| below -115 | will not be reliable - move the antenna or the device |

If it does not work here, **do not go on** - see the troubleshooting table at
the end.

---

## Step 8 - switching the node's network off

This is the whole point of the exercise. After this step the node **disappears
from the network**.

### 8.1 The way back in, first

We put a password on the node's own access point. That is how you get in if the
radio does not reach it. The firmware will not enable an access point without a
password.

1. Open `http://<IP-of-the-node>/#/settings/access-point`
2. It says **"Access point and range extender settings"**.
3. Tick **Enable access point**.
4. In the **Password** field type a password - at least 8 characters.
  **Write it down on paper.**
5. Click **Save**.

### 8.2 Now switch the WiFi off

Open this in the browser, changing only the IP address:

```
http://<IP-of-the-node>/rpc/Wifi.SetConfig?config=%7B%22sta%22%3A%7B%22enable%22%3Afalse%7D%7D
```

It looks frightening but it is just "switch the WiFi client off", written so the
browser cannot mangle it. Copy it exactly as it is.

**What you should see:** `{"restart_required":false}` - and then the page stops
responding. **That is normal and means it worked.**

> We do it with this address rather than from the **Settings → Wi-Fi** menu,
> because this way the WiFi network name and password are certainly kept. They
> are needed for the node to come back later.

### 8.3 Check

1. Type the node's IP address into the browser. **It should not open.**
2. Open `http://<IP-of-the-gateway>/#/virtual`. The `Node ...` sensors should
  keep updating and `Node Link` should stay on.
3. Press **Node Output**. The node's relay should click.

**Done.** The node can go to where it belongs.

---

## Using it from now on

Everything goes through the **gateway**. You do not touch the node again.

- **Home Assistant:** Settings → Devices & Services → Add integration → Shelly
  → the **gateway's** IP address. It brings in both its own sensors and the
  node's ten. The node's switch shows up as an ordinary `switch`.
- **The Shelly app:** the same, you see it on the gateway.
- The node **cannot** be added anywhere on its own. It has no address. That is
  not a shortcoming, that is the idea.

The gateway's home page has a **LoRa (100)** panel showing `Air time`. That is
how much of the time the radio is transmitting. It must stay below **1%**.

---

## If something goes wrong - getting the node back

The node has no network, but it is **not lost**. Two ways.

### 1. Over the radio, without walking over to it

Open this in the browser, changing only the IP to the **gateway's**:

```
http://<IP-of-the-gateway>/rpc/LoRa.Send?id=100&lr_addr=%2200010002%22&data=Q3x3fA%3D%3D
```

That thing at the end is the command "switch your WiFi back on". The node turns
its WiFi on and reboots.

**What you should see:** `null`. That means the command was accepted.

Measured: the node is back on the network in **about 9 seconds**, on its old IP
address. Its WiFi network name and password are kept.

If nothing happens, try a second time. The radio does drop a message now and
then.

### 2. Through its own access point

If the radio does not reach - walk over to the node, look for a WiFi network
called `Shelly1PMG4-...`, connect with the password from step 8.1, and open:

```
http://192.168.33.1
```

---

## Troubleshooting

| problem | what to do |
|---|---|
| `AddOn.GetInfo` gives an error | Switch the power off. Press the add-on in all the way. Power up again. |
| In the script: `no LoRa component` | Step 3 was not done on this device. |
| In the script: `CONFIG.key is still the placeholder` | You did not change the key. See step 5, point 4. |
| In the script: `radio setup failed` | The key is not 16 bytes. It needs 24 characters ending in `==`. Make a new one and put it on **both**. |
| The `Node ...` sensors are missing | The gateway's script is not running, or it stopped. Open **Scripts** on the gateway. |
| The sensors are there but all zero and `Node Link` is off | The two cannot hear each other. Check: the same key on both? different `myAddr`? antennas fitted? |
| I press `Node Output` and nothing happens | Wait 15 seconds - it makes 3 attempts. If the switch flips back by itself, the node is not answering. |
| The script stops by itself | Open **Scripts**, read the error, and post it in this repo's Issues. |
| It worked, then stopped | Look at `Node Seq`. If it has not moved for minutes, the node has no power or its script stopped. |
| `Air time` is above 1% | Something is transmitting too often. Put `heartbeatMs` back to `120000`. |
| I want to remove everything | Stop and delete the scripts. The ten virtual components **stay** - delete them by hand from **Components**. |

---

## What this does NOT do

Honestly, so you do not wonder:

- **It carries only the switch and the measured values.** The node's inputs,
  schedules and other settings are not visible.
- **One node per gateway.** More than that needs a change in the code.
- **It is slow.** About 2 seconds from pressing to clicking. That is what LoRa
  is like.
- **It is not for things that must happen now.** Do not put it on something
  where a 2 second delay or one dropped message is a problem.
- **It is not a WiFi replacement.** It carries a few numbers every 2 minutes,
  not video.
- **Values update every 2 minutes**, not continuously. That is deliberate - see
  below.

---

## Why some things are the way they are

- **Messages get repeated.** LoRa has no acknowledgement, and the radio cannot
  listen and talk at the same time. So a command sent exactly while the node is
  transmitting is lost. The gateway sends it again, up to 3 times, and treats
  the node's own report as the acknowledgement. If it still does not land, it
  writes the switch back to the real state instead of showing you a lie.
- **A report every 2 minutes, not every second.** The law allows the radio to
  transmit 1% of the time - that is 36 seconds per hour. One report is 0.317
  seconds of air time. Every 2 minutes means 30 reports, or 9.5 seconds per hour
  - so **26% of the allowed 36 seconds**, at an overall duty of 0.26%. Every
  minute would be 19 seconds, or **53%** of the allowance, leaving no room for
  the commands and the retries.
- **The values are written by an internal path.** A Shelly script may only have
  **5 requests in flight at once**. The sixth throws an error and **kills the
  script**. Ten sensors over requests does not work.

---

## Settings you can change

At the top of the script, in the `CONFIG` block:

| setting | what it does | watch out |
|---|---|---|
| `radio.dr` | 7 = fast and near, 12 = slow and far. Default 9. | A lower number means less range |
| `heartbeatMs` | how often the node reports. Default 120000 (2 minutes). | More often means more air time. Do not go below 60000 unless you also lower `dr` |
| `offlineMs` | how much silence before `Node Link` goes off. | Must be more than twice `heartbeatMs` |
| `retries` | how many times a command is repeated. Default 3. | |
| `vcBaseId` | the first id for the virtual components. Default 200. | Change it if you already have your own virtual components numbered 200-207 - otherwise the script will use those |

---

## Tested on

| | |
|---|---|
| devices | 2 x Shelly 1 PM Gen4 (`S4SW-001P16EU`) |
| firmware | brought up on 2.0.0; the gateway also verified on 2.1.1 |
| add-on | Shelly LoRa Add-On, firmware 2.0.1, hardware 1.4.0/2520 |
| radio | EU868, 868.1 MHz, SF9, 14 dBm |
| signal | RSSI -25 dBm, SNR 11 |
| control | 12 of 12 commands confirmed, 2.5 s median |
| radio link | 0 frames lost out of 20 on an idle channel |

---

## Files

| file | what it is for |
|---|---|
| `lora-gateway.shelly.js` | the script. Goes on **both** devices, with a different `role` |
| `provision.sh` | optional, Linux/Mac: enables the add-on and makes the key for you |
| `lora-key.txt` | the secret key, if you used `provision.sh`. **Do not upload it anywhere** |
| `README.bg.md` | the same guide in Bulgarian |
| `ha-bridge/` | the older version of the same thing, with two separate scripts and a Python installer. For Home Assistant, and for people used to a command line. You do not need it if you follow the guide above |

### provision.sh

Does steps 3 and 4 for you:

```bash
git clone https://github.com/drHouse-gif/shelly-lora-gateway.git
cd shelly-lora-gateway
chmod +x provision.sh
./provision.sh 192.168.1.50 192.168.1.51
```

The first address is the gateway, the second the node. At the end it prints the
line with the key to put into the script. You can run it as many times as you
like.

## Licence

Apache 2.0 - see `LICENSE`.
