require("dotenv").config();

const express = require("express");
const pino = require("pino");
const path = require("path");
const fs = require("fs");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const WORKER_SECRET = process.env.WORKER_SECRET;
const AUTH_ROOT = process.env.AUTH_ROOT || path.join(process.cwd(), "sessions");
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const sessions = new Map();

fs.mkdirSync(AUTH_ROOT, { recursive: true });

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function sessionDir(phone) {
  return path.join(AUTH_ROOT, phone);
}

function requireSecret(req, res, next) {
  if (!WORKER_SECRET) {
    return res.status(503).json({ error: "WORKER_SECRET is not configured" });
  }

  if (req.get("x-worker-secret") !== WORKER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function publicStatus(phone) {
  const item = sessions.get(phone);

  return {
    phone,
    status: item?.status || "offline",
    connected: item?.status === "connected",
    hasPairingCode: Boolean(item?.pairingCode)
  };
}

async function startSession(phone, requestCode = false) {
  const existing = sessions.get(phone);

  if (existing?.starting) return existing;
  if (existing?.status === "connected" && !requestCode) return existing;

  const item = existing || {
    phone,
    status: "starting",
    pairingCode: null,
    socket: null,
    starting: true,
    lastError: null
  };

  item.starting = true;
  item.status = "starting";
  item.lastError = null;
  sessions.set(phone, item);

  try {
    const authPath = sessionDir(phone);
    fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["Jay Tex MultiBot", "Chrome", "1.0.0"]
    });

    item.socket = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        item.status = "connected";
        item.pairingCode = null;
        item.starting = false;
        item.lastError = null;
        logger.info({ phone }, "WhatsApp connected");
      }

      if (connection === "close") {
        item.status = "disconnected";
        item.starting = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        item.lastError = lastDisconnect?.error?.message || "Connection closed";

        logger.warn({ phone, statusCode }, "WhatsApp disconnected");

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            startSession(phone, false).catch((err) => {
              logger.error({ phone, err: err.message }, "Reconnect failed");
            });
          }, 3000);
        } else {
          item.status = "logged_out";
          item.pairingCode = null;
        }
      }
    });

    if (requestCode && !state.creds.registered) {
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const code = await sock.requestPairingCode(phone);

      item.pairingCode = code;
      item.status = "pairing";
      item.starting = false;
    } else {
      item.starting = false;
    }

    return item;
  } catch (err) {
    item.starting = false;
    item.status = "error";
    item.lastError = err.message;

    logger.error({ phone, err: err.message }, "Session start failed");
    throw err;
  }
}

app.get("/", (_req, res) => {
  res.send("Jay Tex WhatsApp Worker is running!");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "jay-tex-whatsapp-worker",
    activeSessions: sessions.size
  });
});

app.post("/api/pairing/request", requireSecret, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      error: "Enter phone number with country code"
    });
  }

  try {
    const item = await startSession(phone, true);

    res.json({
      phone,
      status: item.status,
      pairingCode: item.pairingCode || null,
      message: item.pairingCode
        ? "Enter this code in WhatsApp Linked Devices"
        : "Session started. Check status shortly."
    });
  } catch (err) {
    res.status(500).json({
      error: "Pairing request failed",
      detail: err.message
    });
  }
});

app.get("/api/status/:phone", requireSecret, (req, res) => {
  const phone = normalizePhone(req.params.phone);

  if (!phone) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  res.json(publicStatus(phone));
});

app.post("/api/send", requireSecret, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const jid = String(req.body?.jid || "").trim();
  const message = String(req.body?.text || "");

  if (!phone || !jid || !message.trim()) {
    return res.status(400).json({
      error: "phone, jid and text are required"
    });
  }

  const item = sessions.get(phone);

  if (!item?.socket || item.status !== "connected") {
    return res.status(409).json({
      error: "WhatsApp session is not connected",
      status: item?.status || "offline"
    });
  }

  try {
    await item.socket.sendMessage(jid, { text: message });

    res.json({
      success: true,
      phone,
      jid
    });
  } catch (err) {
    res.status(500).json({
      error: "Message send failed",
      detail: err.message
    });
  }
});

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message }, "Request error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "Jay Tex Worker started");
});
                 
