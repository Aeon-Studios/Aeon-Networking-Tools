const state = {
  history: []
};

const elements = {
  hostname: document.querySelector("#hostname"),
  platform: document.querySelector("#platform"),
  publicIp: document.querySelector("#public-ip"),
  activeInterfaces: document.querySelector("#active-interfaces"),
  internetHealth: document.querySelector("#internet-health"),
  internetNote: document.querySelector("#internet-note"),
  interfacesResult: document.querySelector("#interfaces-result"),
  activityFeed: document.querySelector("#activity-feed")
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function setBusy(button, busy, label) {
  if (!button) {
    return;
  }

  if (!button.dataset.originalLabel) {
    button.dataset.originalLabel = button.textContent;
  }

  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.originalLabel;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function timestamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function pushActivity(title, detail) {
  state.history.unshift({ title, detail, at: timestamp() });
  state.history = state.history.slice(0, 8);
  renderActivity();
}

function renderActivity() {
  if (!state.history.length) {
    elements.activityFeed.innerHTML = '<p class="activity-empty">No actions yet.</p>';
    return;
  }

  elements.activityFeed.innerHTML = state.history
    .map(
      (entry) => `
        <article class="activity-item">
          <strong>${escapeHtml(entry.title)}</strong>
          <div>${escapeHtml(entry.detail)}</div>
          <small>${escapeHtml(entry.at)}</small>
        </article>
      `
    )
    .join("");
}

function renderKeyValueResult(containerId, title, entries, tone = "good") {
  const container = document.querySelector(`#${containerId}`);
  const template = document.querySelector("#key-value-template");
  container.innerHTML = "";

  const titleNode = document.createElement("h4");
  titleNode.className = `result-title status-${tone}`;
  titleNode.textContent = title;
  container.appendChild(titleNode);

  const wrapper = document.createElement("div");
  wrapper.className = "result-meta";

  entries.forEach(([label, value]) => {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector(".kv-key").textContent = label;
    fragment.querySelector(".kv-value").textContent = value;
    wrapper.appendChild(fragment);
  });

  container.appendChild(wrapper);
}

function renderInterfaces(interfaces) {
  if (!interfaces.length) {
    elements.interfacesResult.innerHTML = '<div class="empty">No interfaces found.</div>';
    return;
  }

  elements.interfacesResult.innerHTML = interfaces
    .map((entry) => {
      const addresses = entry.addresses
        .map(
          (address) => `
            <div class="adapter-address">
              <span>${escapeHtml(address.family)}</span>
              <span>${escapeHtml(address.address)}</span>
            </div>
          `
        )
        .join("");

      return `
        <article class="adapter-card">
          <h4>${escapeHtml(entry.name)} ${entry.active ? '<span class="status-good">active</span>' : ""}</h4>
          ${addresses || '<div class="adapter-address"><span>No addresses</span><span>-</span></div>'}
        </article>
      `;
    })
    .join("");
}

function renderOverview(overview) {
  elements.hostname.textContent = overview.hostname || "Unknown";
  elements.platform.textContent = `${overview.platform} • ${overview.arch}`;
  elements.publicIp.textContent = overview.publicIp || "Unavailable";
  elements.activeInterfaces.textContent = String(overview.activeInterfaces ?? 0);
  renderInterfaces(overview.interfaces || []);
}

function getFormData(name) {
  const form = document.querySelector(`[data-form="${name}"]`);
  const values = Object.fromEntries(new FormData(form).entries());

  Object.keys(values).forEach((key) => {
    if (/^\d+$/.test(values[key])) {
      values[key] = Number(values[key]);
    }
  });

  return values;
}

async function loadOverview() {
  const button = document.querySelector("#refresh-overview");
  setBusy(button, true, "Refreshing...");

  try {
    const overview = await requestJson("/api/overview");
    renderOverview(overview);
    pushActivity("Overview refreshed", `${overview.activeInterfaces} adapter(s) detected`);
  } catch (error) {
    pushActivity("Overview failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function runInternetCheck() {
  const button = document.querySelector("#run-internet-check");
  setBusy(button, true, "Checking...");

  try {
    const payload = await requestJson("/api/internet-check");
    const good = payload.internetReachable;
    elements.internetHealth.textContent = good ? "Online" : "Issues Found";
    elements.internetHealth.className = good ? "status-good" : "status-warn";
    elements.internetNote.textContent = good
      ? `Ping ${payload.ping.avgMs ?? "?"} ms • HTTP ${payload.http.status ?? "?"}`
      : payload.http.error || payload.ping.error || "Detailed tools can help isolate the issue.";
    pushActivity("Internet check", good ? "Internet looks reachable" : "Connectivity issues detected");
  } catch (error) {
    elements.internetHealth.textContent = "Failed";
    elements.internetHealth.className = "status-bad";
    elements.internetNote.textContent = error.message;
    pushActivity("Internet check failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function handlePing(button) {
  setBusy(button, true, "Pinging...");
  try {
    const payload = await requestJson("/api/ping", {
      method: "POST",
      body: JSON.stringify(getFormData("ping"))
    });

    renderKeyValueResult(
      "ping-result",
      payload.success ? "Ping successful" : "Ping failed",
      [
        ["Target", payload.target],
        ["Average latency", payload.avgMs ? `${payload.avgMs} ms` : "Unavailable"],
        ["Packet loss", payload.packetLossPercent !== null ? `${payload.packetLossPercent}%` : "Unavailable"],
        ["Received", payload.received !== null ? String(payload.received) : "Unavailable"],
        ["Notes", payload.stderr || payload.error || "Command completed"]
      ],
      payload.success ? "good" : "warn"
    );

    pushActivity("Ping complete", `${payload.target} • avg ${payload.avgMs ?? "?"} ms`);
  } catch (error) {
    renderKeyValueResult("ping-result", "Ping error", [["Message", error.message]], "bad");
    pushActivity("Ping failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function handleDns(button) {
  setBusy(button, true, "Looking up...");
  try {
    const payload = await requestJson("/api/dns", {
      method: "POST",
      body: JSON.stringify(getFormData("dns"))
    });

    renderKeyValueResult(
      "dns-result",
      `DNS results for ${payload.target}`,
      [
        ["IPv4", payload.ipv4.join(", ") || "None"],
        ["IPv6", payload.ipv6.join(", ") || "None"],
        ["MX", payload.mx.map((entry) => `${entry.exchange} (${entry.priority})`).join(", ") || "None"],
        ["NS", payload.ns.join(", ") || "None"],
        ["TXT", payload.txt.join(" | ") || "None"],
        ["Notes", payload.notes.join(" | ") || "No resolver warnings"]
      ],
      "good"
    );

    pushActivity("DNS lookup", payload.target);
  } catch (error) {
    renderKeyValueResult("dns-result", "DNS error", [["Message", error.message]], "bad");
    pushActivity("DNS lookup failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function handlePortCheck(button) {
  setBusy(button, true, "Probing...");
  try {
    const payload = await requestJson("/api/port-check", {
      method: "POST",
      body: JSON.stringify(getFormData("port-check"))
    });

    renderKeyValueResult(
      "port-check-result",
      payload.open ? "Port is open" : "Port is closed or blocked",
      [
        ["Host", payload.host],
        ["Port", String(payload.port)],
        ["Duration", `${payload.durationMs} ms`],
        ["Message", payload.message]
      ],
      payload.open ? "good" : "warn"
    );

    pushActivity("Port probe", `${payload.host}:${payload.port} • ${payload.open ? "open" : "closed"}`);
  } catch (error) {
    renderKeyValueResult("port-check-result", "Port probe error", [["Message", error.message]], "bad");
    pushActivity("Port probe failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function handleHttpCheck(button) {
  setBusy(button, true, "Checking...");
  try {
    const payload = await requestJson("/api/http-check", {
      method: "POST",
      body: JSON.stringify(getFormData("http-check"))
    });

    renderKeyValueResult(
      "http-check-result",
      payload.ok ? "Endpoint reachable" : "Endpoint failed",
      [
        ["URL", payload.url],
        ["Status", payload.status ? `${payload.status} ${payload.statusText}` : payload.error],
        ["Duration", `${payload.durationMs} ms`],
        ["Server", payload.headers?.server || "Unknown"]
      ],
      payload.ok ? "good" : "warn"
    );

    pushActivity("HTTP check", `${payload.url} • ${payload.status ?? payload.error}`);
  } catch (error) {
    renderKeyValueResult("http-check-result", "HTTP check error", [["Message", error.message]], "bad");
    pushActivity("HTTP check failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function handleTraceroute(button) {
  setBusy(button, true, "Tracing...");
  try {
    const payload = await requestJson("/api/traceroute", {
      method: "POST",
      body: JSON.stringify(getFormData("traceroute"))
    });

    const container = document.querySelector("#traceroute-result");
    container.innerHTML = `
      <h4 class="result-title status-${payload.ok ? "good" : "bad"}">${payload.ok ? "Route captured" : "Traceroute failed"}</h4>
      <p class="trace-output">${escapeHtml(payload.output || payload.stderr || payload.error || "No output")}</p>
    `;

    pushActivity("Traceroute", payload.target);
  } catch (error) {
    renderKeyValueResult("traceroute-result", "Traceroute error", [["Message", error.message]], "bad");
    pushActivity("Traceroute failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function handleSpeedTest(button) {
  setBusy(button, true, "Running...");
  try {
    const payload = await requestJson("/api/speed-test", {
      method: "POST",
      body: JSON.stringify({})
    });

    renderKeyValueResult(
      "speed-test-result",
      payload.ok ? "Speed test complete" : "Speed test failed",
      [
        ["Source", payload.source],
        ["Download", payload.downloadMbps ? `${payload.downloadMbps} Mbps` : "Unavailable"],
        ["Latency", payload.latencyMs ? `${payload.latencyMs} ms` : "Unavailable"],
        ["Transfer", `${Math.round(payload.bytesTransferred / 1024 / 1024)} MB`],
        ["Notes", payload.error || "Approximate benchmark"]
      ],
      payload.ok ? "good" : "warn"
    );

    pushActivity("Speed test", payload.ok ? `${payload.downloadMbps} Mbps` : payload.error);
  } catch (error) {
    renderKeyValueResult("speed-test-result", "Speed test error", [["Message", error.message]], "bad");
    pushActivity("Speed test failed", error.message);
  } finally {
    setBusy(button, false);
  }
}

function bindActions() {
  document.querySelector("#refresh-overview").addEventListener("click", loadOverview);
  document.querySelector("#run-internet-check").addEventListener("click", runInternetCheck);
  document.querySelector('[data-action="refresh-interfaces"]').addEventListener("click", loadOverview);
  document.querySelector('[data-action="ping"]').addEventListener("click", (event) => handlePing(event.currentTarget));
  document.querySelector('[data-action="dns"]').addEventListener("click", (event) => handleDns(event.currentTarget));
  document.querySelector('[data-action="port-check"]').addEventListener("click", (event) => handlePortCheck(event.currentTarget));
  document.querySelector('[data-action="http-check"]').addEventListener("click", (event) => handleHttpCheck(event.currentTarget));
  document.querySelector('[data-action="traceroute"]').addEventListener("click", (event) => handleTraceroute(event.currentTarget));
  document.querySelector('[data-action="speed-test"]').addEventListener("click", (event) => handleSpeedTest(event.currentTarget));
}

async function initialize() {
  bindActions();
  renderActivity();
  await loadOverview();
  await runInternetCheck();
}

initialize().catch((error) => {
  pushActivity("App failed to initialize", error.message);
});
