# Shelly LoRa gateway + slave pair

Two Shelly 1 PM Gen4 (`S4SW-001P16EU`, device fw 2.0.0) each with a Shelly LoRa
Add-On (hw `1.4.0/2520`, add-on fw 2.0.1). One keeps WiFi and is the only one
Home Assistant talks to; the other has no network at all and is reached purely
over LoRa.

| | gateway (master) | slave |
|---|---|---|
| IP | `$GW` from `ips.env` | none - WiFi station disabled |
| LoRa address | `00010001` (65537) | `00010002` (65538) |
| script | `lora-gateway` | `lora-slave` |
| in Home Assistant | its own config entry | mirrored onto the gateway |

Only the gateway is added to Home Assistant. Put the two addresses in
`ips.env` (copy `ips.env.example`); nothing here hard-codes them.

## Why the slave is not its own HA device

The HA Shelly integration reaches a device over local RPC on its IP. A device
with no network has no IP, so it cannot be a config entry. Everything about the
slave is therefore published as **virtual components on the gateway**, which the
integration turns into ordinary entities. Short of running MQTT discovery, a
single device carrying mirrored entities is the only option.

## Radio

```
band_plan EU868   freq 868 100 000 Hz   bw 125 kHz   dr/SF 9   cr 4:5
plen 10           txp 14 dBm            rx_enable true
```

SheLr (Shelly Long Range) carries the payload: AES-CCM encrypted, addressed,
18 bytes of overhead per frame. On this firmware there is **no** separate
`shelr:200` component and no `SheLr.*` RPC namespace - the whole thing lives
inside `lora:100`'s config under `shelr`, and `shelr.accept` only accepts the
value `user`. RPC-over-LoRa does not exist here.

Measured on the bench: RSSI -25 dBm, SNR 11 dB, 0 frames lost in 20, and
`tx_time` 317 ms per report frame.

A generalised version of these two scripts, with the Home Assistant specifics
taken out and the two roles merged into one file, went upstream as
`lora/lora-gateway/` in ALLTERCO/shelly-script-examples#236.

### Duty cycle

868.1 MHz is in the EU868 1% sub-band: 36 s of transmission per hour.

| | air time per frame | frames/hour | duty |
|---|---|---|---|
| report (heartbeat, 120 s) | 317 ms | 30 | 0.26% |
| report at a 60 s heartbeat | 317 ms | 60 | 0.53% |
| command | ~250 ms | event driven | - |

The 120 s heartbeat is deliberate: 60 s spends over half the legal budget and
leaves nothing for a burst of commands plus retries. `LoRa.GetStatus` reports
`air_time_hr_ms`, which is the number to watch.

To trade range for responsiveness, change `dr` in `install.py`'s `RADIO` dict
and re-run it - SF7 is roughly a quarter of the air time of SF9, and the link
has about 100 dB of margin on the bench. Raise `dr` towards 12 for range at the
cost of air time.

## Wire protocol

Pipe separated ASCII, base64 on the wire.

```
slave -> gateway   S|<on>|<apower>|<voltage>|<current>|<energy_wh>|<tC>|<seq>
gateway -> slave   C|<cmd>|<arg>
```

| cmd | arg | effect |
|---|---|---|
| `o` | `0`/`1` | set the slave's output |
| `t` | - | toggle |
| `r` | - | report now |
| `w` | - | re-enable the WiFi station, then reboot |
| `b` | - | reboot |

`seq` wraps at 256 and only moves when a frame is actually transmitted, so a
gap in `sensor...lora_slave_seq` is a lost frame.

## Virtual components on the gateway

Created by `install.py` with forced ids, not by an `@meta` block - the `@meta`
route truncates silently past about 1 KB and assigns ids on its own.

| key | name | HA entity | unit |
|---|---|---|---|
| `boolean:200` | LoRa Slave Output | `switch` | - |
| `boolean:201` | LoRa Slave Link | `binary_sensor` | - |
| `number:200` | LoRa Slave Power | `sensor` | W |
| `number:201` | LoRa Slave Voltage | `sensor` | V |
| `number:202` | LoRa Slave Current | `sensor` | A |
| `number:203` | LoRa Slave Energy | `sensor` | Wh |
| `number:204` | LoRa Slave Temperature | `sensor` | °C |
| `number:205` | LoRa Slave RSSI | `sensor` | dBm |
| `number:206` | LoRa Slave SNR | `sensor` | dB |
| `number:207` | LoRa Slave Seq | `sensor` | - |

`meta.ui.view` decides the platform: `toggle` makes a boolean a switch, `label`
makes it a binary_sensor; numbers with `label` become sensors. Names are ASCII
on purpose - the 64 character limit is counted in `\uXXXX` escaped form, which
caps Cyrillic at 10 letters.

## Things this firmware taught us the hard way

- **`Shelly.call()` throws `Too many calls in progress` on the sixth request
  still in flight**, and an uncaught error *stops the script dead*. The first
  version of `lora-gateway.js` issued eight `Number.Set` calls per report and
  died half way through, leaving RSSI, SNR and Link permanently stale.
  `Virtual.getHandle(key).setValue(v)` is an in-process call with no such cap -
  ten in a row are fine. Every handler is wrapped in `try`/`catch` as well.
- **`handle.setValue()` stamps `delta.source` as `sys`; an external RPC write
  stamps `rpc`.** That is the discriminator the gateway uses to tell its own
  mirror writes apart from a real command out of Home Assistant - no suppress
  flag, no race.
- **The receive event does not match the published docs on this firmware.** In a
  script the payload is under `e.info` and `e.info.sender` is a **number**
  (65537), not a hex string.
- **A SheLr `user` frame has no ACK and no retry, and the radio is half duplex.**
  The gateway closes the loop itself: it resends an unconfirmed command every
  4 s up to 3 times (checked on a 1 s tick, so a resend happens at 4 s and not
  at twice that), treats the slave's state report as the ACK, and if the
  command never lands it writes the slave's real state back so Home Assistant
  stops showing a lie. While a command is unconfirmed the mirror deliberately
  ignores incoming reports, otherwise a stale report bounces the switch back.

  Measured from Home Assistant with the slave off the network: 12 of 12
  commands confirmed, median 2.5 s, worst 6.4 s after one retry. Raw frame loss
  on an idle link was 0 in 20, so the losses are half-duplex collisions once
  both ends are talking, not a weak link.
- **`Timer.set` takes milliseconds.** Seconds silently never fire.
- **`Shelly.GetComponents` paginates** - follow `offset`/`total` or components
  past the first page look like they are missing.
- **The LoRa add-on only appears after** `Sys.SetConfig {"device":{"addon_type":"lora"}}`
  plus a reboot. Before that there is no `lora:100` and no `LoRa.*` RPC at all.
- **`LNM.*` is not LoRa.** Its `addr` wants `address:port` - it is an IP proxy.

## Recovering the slave

It has no IP. Two ways back:

1. **Over LoRa**, from the gateway - no physical access needed:

   ```bash
   curl -s -X POST "http://$GW/rpc" -H 'Content-Type: application/json' \
     -d '{"id":1,"method":"LoRa.Send","params":{"id":100,"lr_addr":"00010002","data":"Q3x3fA=="}}'
   ```

   `Q3x3fA==` is base64 for `C|w|`. Measured: back on the LAN in about 9 s,
   script running again after the reboot. A partial `Wifi.SetConfig` merges, so
   the stored SSID and password survive.

2. **Its own AP.** Gen4 firmware refuses to enable an AP without a password, so
   it has one - see `ap-password.txt` (mode 600, not committed).

Then re-run `install.py`, which also puts the station back the way it was.

## Files

| file | what |
|---|---|
| `install.py` | provisions radio, SheLr keys, virtual components and both scripts. `--check` reports without changing anything |
| `lora-gateway.js` | runs on the gateway, the device that keeps WiFi |
| `lora-slave.js` | runs on the slave, the device with no network |
| `aes.key` | shared 128-bit SheLr key, mode 600, **not** committed |
| `ap-password.txt` | rescue AP password, mode 600, **not** committed |
| `ips.env` | the two addresses, mode 600, **not** committed - copy `ips.env.example` |

`install.py` is idempotent - re-running it re-pushes the scripts and reconciles
the virtual components. It retries transport errors, because a Shelly's HTTP
server accepts very few concurrent connections and will time out if anything
else is polling it.

## Known limits

- Device firmware 2.0.0 is installed; **2.1.1 is available**. Not applied - the
  pair is working and an OTA mid-bring-up buys nothing. 2.1.1 may split SheLr
  into its own `shelr:2xx` component and add the `rpc` payload type, which would
  allow real RPC over LoRa instead of this hand-rolled protocol.
- Only the slave's output is controllable from HA. Its input, schedules and
  everything else are not mirrored.
- `aenergy.total` is sent as whole Wh, so the HA sensor is in Wh while the
  gateway's own energy sensor is in kWh.
- One slave only. The address scheme has room: group `0001`, so a third device
  is `00010003` and `0001FFFF` is multicast to the group.
