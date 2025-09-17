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

function disconnectPair(socketId) {
  const partnerId = findPartner(socketId);
  if (partnerId) {
    io.to(partnerId).emit("partner-disconnected");
    
    connectedPairs.delete(socketId);
    connectedPairs.delete(partnerId);
    
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      // Put the disconnected partner back into the queue to find a new match.
      removeFromWaiting(partnerId); // Ensure they aren't duplicated in the queue
      waitingUsers.push({ id: partnerId, socket: partnerSocket, joinedAt: Date.now() });
      io.to(partnerId).emit("searching");
    }
  }
}

// ✅ NEW: Centralized function to find a partner and prevent self-matching
function findAndPairUsers(socket) {
  // Find the index of the first user in the queue who is NOT the current user.
  const partnerIndex = waitingUsers.findIndex(user => user.id !== socket.id);
  
  if (partnerIndex !== -1) {
    // A valid partner was found.
    const partner = waitingUsers.splice(partnerIndex, 1)[0]; // Remove partner from queue
    
    connectedPairs.set(socket.id, partner.id);
    connectedPairs.set(partner.id, socket.id);
    
    socket.emit("connected");
    partner.socket.emit("connected");
    
    userStats.totalConnections++;
    console.log(`Paired ${socket.id} with ${partner.id}`);
  } else {
    // No suitable partner found, add current user to the waiting queue.
    // First, ensure they aren't already in the queue to prevent duplicates.
    removeFromWaiting(socket.id); 
    waitingUsers.push({ id: socket.id, socket: socket, joinedAt: Date.now() });
    socket.emit("searching");
  }
}


// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  userStats.activeUsers++;
  socket.isVerified = false; // Add verification flag to each socket session

  // ✅ UPDATED: Uses the new matchmaking function
  socket.on("join", () => {
    console.log(`User ${socket.id} joined the queue`);
    findAndPairUsers(socket);
  });

  socket.on("message", async (data) => {
    try {
      const { text, captcha } = data;
      const partnerId = findPartner(socket.id);

      if (!partnerId) {
        return socket.emit("error", { type: "no_partner", message: "No partner connected" });
      }

      // --- MODIFIED CAPTCHA LOGIC ---
      // Only verify captcha if the user hasn't been verified in this session yet.
      if (!socket.isVerified) {
        if (!await verifyRecaptcha(captcha)) {
          return socket.emit("error", { type: "captcha_failed", message: "reCAPTCHA verification failed" });
        }
        // If verification is successful, mark them as verified.
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
  
  // ✅ UPDATED: "next" (skip) logic is now cleaner and more reliable
  socket.on("next", () => {
    console.log(`User ${socket.id} requested next chat`);
    // Disconnects from the current partner. The partner is put back in the queue.
    disconnectPair(socket.id);
    // Now, find a new partner for the current user.
    findAndPairUsers(socket);
  });
  
  socket.on("report", (data) => {
    const { reason } = data;
    const partnerId = findPartner(socket.id);
    console.log(`REPORT: User ${socket.id} reported ${partnerId} for: ${reason}`);
    // Reporting also disconnects the pair. The partner is put back in the queue.
    disconnectPair(socket.id);
    // The reporting user is also put back in the queue.
    findAndPairUsers(socket);
  });
  
  socket.on("ping", () => socket.emit("pong"));
  
  // ✅ UPDATED: Disconnect logic is clean and robust.
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    userStats.activeUsers--;
    // If the user was in the waiting queue, remove them.
    removeFromWaiting(socket.id);
    // If the user was in a chat, disconnect them from their partner.
    // The partner will be notified and requeued automatically.
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
