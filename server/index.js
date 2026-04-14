const express = require("express");
const path = require("node:path");
const {
  checkHttp,
  checkPort,
  getOverview,
  pingHost,
  resolveDns,
  runInternetCheck,
  runSpeedTest,
  runTraceroute
} = require("./network-tools");

function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/overview", async (_request, response) => {
    try {
      response.json(await getOverview());
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  app.get("/api/internet-check", async (_request, response) => {
    try {
      response.json(await runInternetCheck());
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  app.post("/api/ping", async (request, response) => {
    try {
      response.json(await pingHost(request.body?.target, request.body?.count));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/dns", async (request, response) => {
    try {
      response.json(await resolveDns(request.body?.target));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/port-check", async (request, response) => {
    try {
      response.json(await checkPort(request.body?.host, request.body?.port, request.body?.timeoutMs));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/http-check", async (request, response) => {
    try {
      response.json(await checkHttp(request.body?.url));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/traceroute", async (request, response) => {
    try {
      response.json(await runTraceroute(request.body?.target, request.body?.maxHops));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.post("/api/speed-test", async (request, response) => {
    try {
      response.json(await runSpeedTest(request.body?.bytes));
    } catch (error) {
      response.status(400).json({ error: error.message });
    }
  });

  app.get("*", (_request, response) => {
    response.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  return app;
}

function startServer(port = Number(process.env.PORT) || 0) {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        app,
        server,
        port: typeof address === "object" && address ? address.port : port
      });
    });

    server.on("error", reject);
  });
}

if (require.main === module) {
  startServer(Number(process.env.PORT) || 3000)
    .then(({ port }) => {
      console.log(`AEON Networking Tools server is running at http://127.0.0.1:${port}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = {
  createApp,
  startServer
};
