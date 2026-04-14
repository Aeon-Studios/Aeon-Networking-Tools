const dns = require("node:dns").promises;
const net = require("node:net");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { promisify } = require("node:util");
const { URL } = require("node:url");

const execFileAsync = promisify(execFile);
const DEFAULT_SPEED_BYTES = 12 * 1024 * 1024;
const SPEED_TEST_URL = "https://speed.cloudflare.com/__down";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function clipText(value, limit = 5000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function validateTarget(value) {
  const target = normalizeText(value);
  if (!target) {
    throw new Error("Enter a host or IP address.");
  }

  if (!/^[a-zA-Z0-9.\-_:]+$/.test(target)) {
    throw new Error("Only letters, numbers, dots, dashes, underscores, and colons are allowed.");
  }

  return target;
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535.");
  }

  return port;
}

function validateHttpUrl(value) {
  let input = normalizeText(value);
  if (!input) {
    throw new Error("Enter a URL.");
  }

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  return url.toString();
}

function collectInterfaces() {
  return Object.entries(os.networkInterfaces())
    .map(([name, rows]) => ({
      name,
      active: (rows || []).some((row) => !row.internal),
      addresses: (rows || []).map((row) => ({
        address: row.address,
        family: row.family,
        cidr: row.cidr,
        internal: row.internal,
        mac: row.mac
      }))
    }))
    .sort((left, right) => Number(right.active) - Number(left.active));
}

async function lookupPublicIp() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://api.ipify.org?format=json", {
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }

    const body = await response.json();
    return body.ip || null;
  } catch {
    return null;
  }
}

async function getOverview() {
  const interfaces = collectInterfaces();
  return {
    checkedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    publicIp: await lookupPublicIp(),
    activeInterfaces: interfaces.filter((entry) => entry.active).length,
    interfaces
  };
}

function parsePingOutput(stdout) {
  const text = String(stdout || "").replace(/\r/g, "");
  const summary = text.match(/Sent = (\d+), Received = (\d+), Lost = (\d+) \((\d+)% loss\)/i);
  const timing = text.match(/Minimum = (\d+)ms, Maximum = (\d+)ms, Average = (\d+)ms/i);

  return {
    sent: summary ? Number(summary[1]) : null,
    received: summary ? Number(summary[2]) : null,
    lost: summary ? Number(summary[3]) : null,
    packetLossPercent: summary ? Number(summary[4]) : null,
    minMs: timing ? Number(timing[1]) : null,
    maxMs: timing ? Number(timing[2]) : null,
    avgMs: timing ? Number(timing[3]) : null,
    raw: clipText(text)
  };
}

async function pingHost(target, count = 4) {
  const host = validateTarget(target);
  const safeCount = clamp(Number(count) || 4, 1, 8);

  try {
    const { stdout, stderr } = await execFileAsync("ping", ["-n", String(safeCount), host], {
      timeout: 15000,
      windowsHide: true
    });

    const parsed = parsePingOutput(stdout);
    return {
      success: parsed.received > 0,
      target: host,
      count: safeCount,
      stderr: clipText(stderr),
      ...parsed
    };
  } catch (error) {
    const parsed = parsePingOutput(error.stdout || "");
    return {
      success: false,
      target: host,
      count: safeCount,
      error: "Ping failed.",
      stderr: clipText(error.stderr || error.message),
      ...parsed
    };
  }
}

async function resolveDns(target) {
  const host = validateTarget(target);
  const [ipv4, ipv6, mx, txt, ns] = await Promise.allSettled([
    dns.resolve4(host),
    dns.resolve6(host),
    dns.resolveMx(host),
    dns.resolveTxt(host),
    dns.resolveNs(host)
  ]);

  return {
    target: host,
    checkedAt: new Date().toISOString(),
    ipv4: ipv4.status === "fulfilled" ? ipv4.value : [],
    ipv6: ipv6.status === "fulfilled" ? ipv6.value : [],
    mx: mx.status === "fulfilled" ? mx.value : [],
    txt: txt.status === "fulfilled" ? txt.value.map((part) => part.join("")) : [],
    ns: ns.status === "fulfilled" ? ns.value : [],
    notes: [ipv4, ipv6, mx, txt, ns]
      .filter((entry) => entry.status === "rejected")
      .map((entry) => entry.reason?.message)
  };
}

async function checkPort(host, port, timeoutMs = 4000) {
  const target = validateTarget(host);
  const safePort = validatePort(port);
  const timeout = clamp(Number(timeoutMs) || 4000, 500, 15000);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const started = performance.now();
    let done = false;

    const finish = (payload) => {
      if (done) {
        return;
      }

      done = true;
      socket.destroy();
      resolve({
        host: target,
        port: safePort,
        checkedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        ...payload
      });
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => finish({ open: true, message: "TCP connection established." }));
    socket.once("timeout", () => finish({ open: false, message: "Connection timed out." }));
    socket.once("error", (error) => finish({ open: false, message: error.message }));
    socket.connect(safePort, target);
  });
}

async function checkHttp(input) {
  const url = validateHttpUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal
    });
    clearTimeout(timer);

    return {
      ok: response.ok,
      url,
      status: response.status,
      statusText: response.statusText,
      durationMs: Math.round(performance.now() - started),
      checkedAt: new Date().toISOString(),
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      url,
      durationMs: Math.round(performance.now() - started),
      checkedAt: new Date().toISOString(),
      error: error.name === "AbortError" ? "Request timed out." : error.message
    };
  }
}

async function runTraceroute(target, maxHops = 12) {
  const host = validateTarget(target);
  const hops = clamp(Number(maxHops) || 12, 4, 30);

  try {
    const { stdout, stderr } = await execFileAsync("tracert", ["-d", "-h", String(hops), host], {
      timeout: 45000,
      windowsHide: true
    });

    return {
      ok: true,
      target: host,
      maxHops: hops,
      checkedAt: new Date().toISOString(),
      output: clipText(stdout, 8000),
      stderr: clipText(stderr)
    };
  } catch (error) {
    return {
      ok: false,
      target: host,
      maxHops: hops,
      checkedAt: new Date().toISOString(),
      output: clipText(error.stdout || "", 8000),
      stderr: clipText(error.stderr || error.message),
      error: "Traceroute failed."
    };
  }
}

async function runSpeedTest(bytes = DEFAULT_SPEED_BYTES) {
  const targetBytes = clamp(Number(bytes) || DEFAULT_SPEED_BYTES, 1024 * 1024, 40 * 1024 * 1024);
  const url = `${SPEED_TEST_URL}?bytes=${targetBytes}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const started = performance.now();
  let transferredBytes = 0;

  try {
    const latencyCheck = await checkHttp("https://www.cloudflare.com/cdn-cgi/trace");
    const response = await fetch(url, {
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`Speed test failed with HTTP ${response.status}.`);
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      transferredBytes += value.byteLength;
    }

    clearTimeout(timer);
    const durationMs = Math.max(performance.now() - started, 1);
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      source: "Cloudflare speed test",
      bytesTransferred: transferredBytes,
      durationMs: Math.round(durationMs),
      downloadMbps: Number(((transferredBytes * 8) / durationMs / 1000).toFixed(2)),
      latencyMs: latencyCheck.durationMs || null
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      source: "Cloudflare speed test",
      bytesTransferred: transferredBytes,
      durationMs: Math.round(performance.now() - started),
      error: error.name === "AbortError" ? "Speed test timed out." : error.message
    };
  }
}

async function runInternetCheck() {
  const ping = await pingHost("1.1.1.1", 2);
  const http = await checkHttp("https://www.msftconnecttest.com/connecttest.txt");

  return {
    checkedAt: new Date().toISOString(),
    internetReachable: ping.success && http.ok,
    ping,
    http
  };
}

module.exports = {
  checkHttp,
  checkPort,
  getOverview,
  pingHost,
  resolveDns,
  runInternetCheck,
  runSpeedTest,
  runTraceroute
};
