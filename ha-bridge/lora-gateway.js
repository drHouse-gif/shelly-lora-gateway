// LoRa gateway for Shelly 1PM Gen4 + LoRa Add-On.
//
// Mirrors a LoRa-only slave into this device's virtual components, so Home
// Assistant - which can only reach this device over WiFi - sees the slave's
// readings and can switch it. Commands travel back out over LoRa.
//
// The virtual components are created by install.py, not by an @meta block, so
// the ids below are fixed and known.
//
// Wire protocol (SheLr "user" payload, base64 on the wire):
//   in   S|<on>|<apower>|<voltage>|<current>|<energy_wh>|<tC>|<seq>
//   out  C|<cmd>|<arg>   cmd: o=set output, t=toggle, r=report now,
//                             w=re-enable WiFi station, b=reboot

let CFG = {
  lora: 100,
  sl_addr: "00010002", // slave SheLr address, as LoRa.Send wants it
  sl_num: 65538,       // 0x00010002 - rx events carry the sender as a number
  // The slave heartbeats every 120 s, so this has to span more than two of
  // them - otherwise one missed frame reads as a dead link.
  offline_ms: 320000,
  watch_ms: 15000,     // how often the link is re-checked
  settle_ms: 5000,     // ignore control writes while the device boots
  retry_ms: 4000,      // unconfirmed command -> send it again
  retries: 3,          // then give up and show the slave's real state
  tick_ms: 1000,       // retry timer granularity, kept well under retry_ms so
                       // a resend happens at retry_ms and not at twice it
};

let K_OUT = "boolean:200";

// role -> virtual component key, created by install.py with these exact ids
let KEYS = [
  ["out",  "boolean:200"],
  ["link", "boolean:201"],
  ["pw",   "number:200"],
  ["volt", "number:201"],
  ["cur",  "number:202"],
  ["nrg",  "number:203"],
  ["temp", "number:204"],
  ["rssi", "number:205"],
  ["snr",  "number:206"],
  ["seq",  "number:207"],
];

let H = {};
let last_rx = 0;
let ready = false;

// A SheLr "user" frame is fire and forget: no ACK, no retry, and the radio is
// half duplex, so a command sent while the slave happens to be transmitting is
// simply lost. The slave's state report doubles as the ACK - these three track
// the command still waiting for one.
let want = null;
let want_tries = 0;
let want_at = 0;
let last_out = null; // the slave's most recently reported output
let primed = false; // until the first report lands, write even unchanged
                    // values, so every entity starts with a real timestamp
                    // instead of looking like it was never updated

function bind() {
  let missing = "";
  for (let i = 0; i < KEYS.length; i++) {
    let h = Virtual.getHandle(KEYS[i][1]);
    if (h) H[KEYS[i][0]] = h;
    else missing = missing + " " + KEYS[i][1];
  }
  if (missing !== "") print("missing virtual components:" + missing);
}

function num(s) {
  if (s === undefined || s === null || s === "") return null;
  let v = JSON.parse(s);
  if (typeof v !== "number") return null;
  return v;
}

// handle.setValue() is an in-process call, so a whole report can be written in
// one go. Shelly.call() cannot: it throws "Too many calls in progress" on the
// sixth request still in flight, which killed an earlier version of this
// script half way through a report.
function put(role, v) {
  let h = H[role];
  if (!h || v === null || v === undefined) return;
  if (primed && h.getValue() === v) return;
  h.setValue(v);
}

function sendCmd(cmd, arg) {
  Shelly.call("LoRa.Send",
    { id: CFG.lora, lr_addr: CFG.sl_addr, data: btoa("C|" + cmd + "|" + arg) },
    function (r, ec, em) {
      if (ec) print("lora tx failed " + ec + " " + em);
    });
}

function sendOut(v) {
  want = v;
  want_tries = 0;
  want_at = Shelly.getUptimeMs();
  sendCmd("o", v ? "1" : "0");
}

function onReport(text, rssi, snr) {
  let f = text.split("|");
  if (f[0] !== "S" || f.length < 8) {
    print("bad frame: " + text);
    return;
  }
  last_rx = Shelly.getUptimeMs();
  let on = f[1] === "1";
  last_out = on;
  if (want !== null && on === want) want = null; // the report is the ACK
  // While a command is still unconfirmed the slave keeps reporting its old
  // state, and mirroring that would bounce the switch back under Home
  // Assistant's feet. Show the commanded value until it is confirmed or given
  // up on.
  if (want === null) put("out", on);
  put("pw",   num(f[2]));
  put("volt", num(f[3]));
  put("cur",  num(f[4]));
  put("nrg",  num(f[5]));
  put("temp", num(f[6]));
  put("seq",  num(f[7]));
  put("rssi", rssi);
  put("snr",  snr);
  put("link", true);
  primed = true;
}

Shelly.addEventHandler(function (e) {
  try {
    if (e.component !== "lora:" + CFG.lora) return;
    if (!e.info || e.info.event !== "user_rx" || !e.info.data) return;
    if (e.info.sender !== CFG.sl_num) return;
    onReport(atob(e.info.data), e.info.rssi, e.info.snr);
  } catch (err) {
    print("rx handler error: " + JSON.stringify(err));
  }
});

// Our own mirror writes land here too, but handle.setValue() stamps
// delta.source "sys". Anything from outside - Home Assistant over RPC, the web
// UI, a schedule - arrives as "rpc", and only that is a real command.
Shelly.addStatusHandler(function (e) {
  try {
    if (e.component !== K_OUT) return;
    if (!ready) return;
    if (!e.delta || e.delta.value === undefined) return;
    if (e.delta.source === "sys") return;
    sendOut(e.delta.value);
  } catch (err) {
    print("ctl handler error: " + JSON.stringify(err));
  }
});

// Resend an unconfirmed command, and if it never lands, stop lying to Home
// Assistant about the slave's state.
Timer.set(CFG.tick_ms, true, function () {
  try {
    if (want === null) return;
    if ((Shelly.getUptimeMs() - want_at) < CFG.retry_ms) return;
    if (want_tries >= CFG.retries) {
      print("command unconfirmed after " + want_tries + " retries, reverting");
      want = null;
      if (last_out !== null) put("out", last_out);
      return;
    }
    want_tries++;
    want_at = Shelly.getUptimeMs();
    sendCmd("o", want ? "1" : "0");
    print("command retry " + want_tries);
  } catch (err) {
    print("retry error: " + JSON.stringify(err));
  }
});

Timer.set(CFG.watch_ms, true, function () {
  try {
    if (last_rx === 0) { put("link", false); return; }
    put("link", (Shelly.getUptimeMs() - last_rx) < CFG.offline_ms);
  } catch (err) {
    print("watchdog error: " + JSON.stringify(err));
  }
});

bind();
put("link", false);
Timer.set(CFG.settle_ms, false, function () { ready = true; });
// Ask for a first report instead of waiting out the slave's heartbeat.
Timer.set(3000, false, function () { sendCmd("r", ""); });
print("lora-gateway up, mirroring " + CFG.sl_addr);
