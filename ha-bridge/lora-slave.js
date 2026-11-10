// LoRa slave for Shelly 1PM Gen4 + LoRa Add-On.
//
// This device runs with its WiFi station disabled, so LoRa is the only link it
// has. It reports switch:0 to the gateway and executes commands coming back.
// Every handler is wrapped: an uncaught error stops a Shelly script dead, and
// with no network there would be no way to notice or restart it. The "w"
// command is the remote way back onto WiFi; the device's own AP is the manual
// one.
//
// Wire protocol (SheLr "user" payload, base64 on the wire):
//   out  S|<on>|<apower>|<voltage>|<current>|<energy_wh>|<tC>|<seq>
//   in   C|<cmd>|<arg>   cmd: o=set output, t=toggle, r=report now,
//                             w=re-enable WiFi station, b=reboot

let CFG = {
  lora: 100,
  gw_addr: "00010001", // gateway SheLr address, as LoRa.Send wants it
  gw_num: 65537,       // 0x00010001 - rx events carry the sender as a number
  // One report frame measures 317 ms of air time at SF9 (from the add-on's
  // own tx_time). 868.1 MHz sits in the EU868 1% duty cycle sub-band, which
  // allows 36 s of transmission per hour. A 60 s heartbeat would spend 19 s of
  // that on its own - over half the budget, with nothing left for a burst of
  // commands and retries. At 120 s it costs 9.5 s/hour, about a quarter.
  heartbeat_ms: 120000,
  debounce_ms: 800,    // collapse a burst of triggers into one frame
  min_gap_ms: 3000,    // duty-cycle floor between two transmissions
};

let seq = 0;
let last_tx = 0;
let pending = null;

function num(v, d) {
  if (typeof v !== "number") return "";
  return v.toFixed(d);
}

function build() {
  let s = Shelly.getComponentStatus("switch:0");
  if (!s) return null;
  seq = (seq + 1) % 256;
  let tc = (s.temperature && typeof s.temperature.tC === "number") ? s.temperature.tC : null;
  let wh = (s.aenergy && typeof s.aenergy.total === "number") ? s.aenergy.total : null;
  return "S|" + (s.output ? "1" : "0") +
         "|" + num(s.apower, 1) +
         "|" + num(s.voltage, 1) +
         "|" + num(s.current, 3) +
         "|" + num(wh, 0) +
         "|" + num(tc, 1) +
         "|" + seq;
}

function tx(payload) {
  last_tx = Shelly.getUptimeMs();
  Shelly.call("LoRa.Send",
    { id: CFG.lora, lr_addr: CFG.gw_addr, data: btoa(payload) },
    function (r, ec, em) {
      if (ec) print("lora tx failed " + ec + " " + em);
    });
}

function flush() {
  try {
    pending = null;
    let p = build();
    if (p !== null) tx(p);
  } catch (err) {
    print("flush error: " + JSON.stringify(err));
  }
}

// Always transmit from a deferred slot, never straight away. One command
// produces two triggers - the Switch.Set callback and the output status change
// - and without the debounce each one cost its own frame. The min_gap_ms floor
// on top keeps a burst from eating air time.
function report() {
  try {
    let wait = CFG.debounce_ms;
    let since = Shelly.getUptimeMs() - last_tx;
    if (since < CFG.min_gap_ms) {
      let need = CFG.min_gap_ms - since;
      if (need > wait) wait = need;
    }
    if (pending !== null) Timer.clear(pending);
    pending = Timer.set(wait, false, flush);
  } catch (err) {
    print("report error: " + JSON.stringify(err));
  }
}

function command(text) {
  let f = text.split("|");
  if (f[0] !== "C") return;
  let cmd = f[1];
  let arg = f[2];

  if (cmd === "o") {
    Shelly.call("Switch.Set", { id: 0, on: arg === "1" }, function () { report(); });
  } else if (cmd === "t") {
    Shelly.call("Switch.Toggle", { id: 0 }, function () { report(); });
  } else if (cmd === "r") {
    report();
  } else if (cmd === "w") {
    // Rescue hatch: bring the station back so the device is reachable over IP.
    // A partial sta object merges, so the stored SSID and password survive.
    Shelly.call("Wifi.SetConfig", { config: { sta: { enable: true } } },
      function () { Shelly.call("Shelly.Reboot", {}); });
  } else if (cmd === "b") {
    Shelly.call("Shelly.Reboot", {});
  } else {
    print("unknown command: " + text);
  }
}

Shelly.addEventHandler(function (e) {
  try {
    if (e.component !== "lora:" + CFG.lora) return;
    if (!e.info || e.info.event !== "user_rx" || !e.info.data) return;
    if (e.info.sender !== CFG.gw_num) return;
    command(atob(e.info.data));
  } catch (err) {
    print("rx handler error: " + JSON.stringify(err));
  }
});

// switch:0 emits a power_measurement every second; only an actual output
// change is worth air time.
Shelly.addStatusHandler(function (e) {
  try {
    if (e.component !== "switch:0" || !e.delta) return;
    if (e.delta.output === undefined) return;
    report();
  } catch (err) {
    print("status handler error: " + JSON.stringify(err));
  }
});

Timer.set(CFG.heartbeat_ms, true, report);
Timer.set(2000, false, report);
print("lora-slave up, reporting to " + CFG.gw_addr);
