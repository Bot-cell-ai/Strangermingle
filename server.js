const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// IMPORTANT: Replace with your actual secret key, preferably from environment variables
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY || "YOUR_GOOGLE_RECAPTCHA_SECRET_KEY_HERE";
const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

// User management
let waitingUsers = [];
let connectedPairs = new Map(); // socket.id -> partner's socket.id
let userStats = {
  totalConnections: 0,
  activeUsers: 0,
  totalMessages: 0
};

// reCAPTCHA verification function
async function verifyRecaptcha(token) {
  // In a real app, never disable verification. This is for testing only.
  if (!token || token === 'demo-token') return true;
  if (RECAPTCHA_SECRET_KEY === "YOUR_GOOGLE_RECAPTCHA_SECRET_KEY_HERE") {
    console.warn("reCAPTCHA is not configured. Allowing all requests.");
    return true;
  }

  try {
    const response = await axios.post(RECAPTCHA_VERIFY_URL, null, {
      params: {
        secret: RECAPTCHA_SECRET_KEY,
        response: token
      }
    });
    return response.data.success;
  } catch (error) {
    console.error("reCAPTCHA verification error:", error.message);
    return false;
  }
}

// Utility functions
function findPartner(socketId) {
  return connectedPairs.get(socketId);
}

function removeFromWaiting(socketId) {
  waitingUsers = waitingUsers.filter(user => user.id !== socketId);
}

// --- MODIFIED disconnectPair() FUNCTION ---
// Now disconnects both users and sends them to the "Start" state
// without automatically re-queuing the partner.
function disconnectPair(socketId) {
  const partnerId = findPartner(socketId);
  if (partnerId) {
    // Notify the partner they've been disconnected
    io.to(partnerId).emit("partnerDisconnected");

    // Remove the pair from the map
    connectedPairs.delete(socketId);
    connectedPairs.delete(partnerId);

    // The partner is NOT automatically put back into the waiting queue.
    // Their client will receive the "partnerDisconnected" event and should
    // handle returning to the initial state.
  }
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  userStats.activeUsers++;
  socket.isVerified = false; // Add verification flag to each socket session

  socket.on("join", () => {
    console.log(`User ${socket.id} joined the queue`);
    if (waitingUsers.length > 0) {
      let partnerIndex = waitingUsers.findIndex(u => u.id !== socket.id);

      if (partnerIndex !== -1) {
        const waitingUser = waitingUsers.splice(partnerIndex, 1)[0];
        connectedPairs.set(socket.id, waitingUser.id);
        connectedPairs.set(waitingUser.id, socket.id);

        socket.emit("connected");
        waitingUser.socket.emit("connected");
        userStats.totalConnections++;
        console.log(`Paired ${socket.id} with ${waitingUser.id}`);
      } else {
        waitingUsers.push({ id: socket.id, socket: socket, joinedAt: Date.now() });
        socket.emit("searching");
      }
    } else {
      waitingUsers.push({ id: socket.id, socket: socket, joinedAt: Date.now() });
      socket.emit("searching");
    }
  });

  socket.on("message", async (data) => {
    try {
      const { text, captcha } = data;
      const partnerId = findPartner(socket.id);

      if (!partnerId) {
        return socket.emit("error", { type: "no_partner", message: "No partner connected" });
      }

      if (!socket.isVerified) {
        if (!await verifyRecaptcha(captcha)) {
          return socket.emit("error", { type: "captcha_failed", message: "reCAPTCHA verification failed" });
        }
        socket.isVerified = true;
      }

      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return socket.emit("error", { type: "invalid_message", message: "Invalid message content" });
      }

      if (text.length > 500) {
        return socket.emit("error", { type: "message_too_long", message: "Message too long" });
      }

      io.to(partnerId).emit("message", { text: text.trim() });
      userStats.totalMessages++;
    } catch (error) {
      console.error("Message handling error:", error);
      socket.emit("error", { type: "server_error", message: "Server error occurred" });
    }
  });

  socket.on("typing", () => {
    const partnerId = findPartner(socket.id);
    if (partnerId) io.to(partnerId).emit("typing");
  });

  socket.on("stopTyping", () => {
    const partnerId = findPartner(socket.id);
    if (partnerId) io.to(partnerId).emit("stopTyping");
  });

  // --- UPDATED "next" EVENT ---
  // Disconnects both users and sends them back to the start state, does not auto-rematch.
  socket.on("next", () => {
    console.log(`User ${socket.id} requested next chat`);
    disconnectPair(socket.id);
    removeFromWaiting(socket.id);
    // User is NOT automatically put back in the queue. They must "join" again.
  });

  // --- NEW "skip" EVENT ---
  // Behaves identically to the new "next" event.
  socket.on("skip", () => {
    console.log(`User ${socket.id} skipped chat`);
    disconnectPair(socket.id);
    removeFromWaiting(socket.id);
    // User is NOT automatically put back in the queue. They must "join" again.
  });

  socket.on("report", (data) => {
    const { reason } = data;
    const partnerId = findPartner(socket.id);
    console.log(`REPORT: User ${socket.id} reported ${partnerId} for: ${reason}`);
    disconnectPair(socket.id);
  });

  socket.on("ping", () => socket.emit("pong"));

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    userStats.activeUsers--;
    removeFromWaiting(socket.id);
    disconnectPair(socket.id);
  });
});

// REST API endpoints
app.get("/api/stats", (req, res) => {
  res.json({
    onlineUsers: io.engine.clientsCount, // More accurate online count
    totalChatsToday: userStats.totalConnections,
    waitingInQueue: waitingUsers.length
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
