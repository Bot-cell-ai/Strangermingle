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

// reCAPTCHA configuration
const RECAPTCHA_SECRET_KEY = "process.env.RECAPTCHA_SECRET_KEY"; // Replace with your actual secret key
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
  try {
    if (!token) return false;
    
    const response = await axios.post(RECAPTCHA_VERIFY_URL, null, {
      params: {
        secret: RECAPTCHA_SECRET_KEY,
        response: token
      }
    });
    
    return response.data.success;
  } catch (error) {
    console.error("reCAPTCHA verification error:", error);
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
    // Notify partner about disconnection
    io.to(partnerId).emit("partner-disconnected");
    
    // Remove both from connected pairs
    connectedPairs.delete(socketId);
    connectedPairs.delete(partnerId);
    
    // Add partner back to waiting queue
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      waitingUsers.push({
        id: partnerId,
        socket: partnerSocket,
        joinedAt: Date.now()
      });
      io.to(partnerId).emit("searching");
    }
  }
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  userStats.activeUsers++;
  
  // Handle join request
  socket.on("join", () => {
    console.log(`User ${socket.id} joined the queue`);
    
    // Check if there's a waiting user
    if (waitingUsers.length > 0) {
      const waitingUser = waitingUsers.shift();
      
      // Pair the users
      connectedPairs.set(socket.id, waitingUser.id);
      connectedPairs.set(waitingUser.id, socket.id);
      
      // Notify both users
      socket.emit("connected");
      waitingUser.socket.emit("connected");
      
      userStats.totalConnections++;
      console.log(`Paired ${socket.id} with ${waitingUser.id}`);
    } else {
      // Add to waiting queue
      waitingUsers.push({
        id: socket.id,
        socket: socket,
        joinedAt: Date.now()
      });
      socket.emit("searching");
    }
  });
  
  // Handle message sending
  socket.on("message", async (data) => {
    try {
      const { text, captcha } = data;
      
      // Verify reCAPTCHA
      if (!await verifyRecaptcha(captcha)) {
        socket.emit("error", { 
          type: "captcha_failed",
          message: "reCAPTCHA verification failed" 
        });
        return;
      }
      
      // Validate message
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        socket.emit("error", { 
          type: "invalid_message",
          message: "Invalid message content" 
        });
        return;
      }
      
      if (text.length > 500) {
        socket.emit("error", { 
          type: "message_too_long",
          message: "Message too long" 
        });
        return;
      }
      
      // Find partner and send message
      const partnerId = findPartner(socket.id);
      if (partnerId) {
        io.to(partnerId).emit("message", { text: text.trim() });
        userStats.totalMessages++;
        console.log(`Message from ${socket.id} to ${partnerId}: ${text.substring(0, 50)}...`);
      } else {
        socket.emit("error", { 
          type: "no_partner",
          message: "No partner connected" 
        });
      }
    } catch (error) {
      console.error("Message handling error:", error);
      socket.emit("error", { 
        type: "server_error",
        message: "Server error occurred" 
      });
    }
  });
  
  // Handle typing indicators
  socket.on("typing", () => {
    const partnerId = findPartner(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("typing");
    }
  });
  
  socket.on("stopTyping", () => {
    const partnerId = findPartner(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("stopTyping");
    }
  });
  
  // Handle next chat request
  socket.on("next", () => {
    console.log(`User ${socket.id} requested next chat`);
    
    // Disconnect current pair
    disconnectPair(socket.id);
    
    // Remove from waiting queue if present
    removeFromWaiting(socket.id);
    
    // Add back to queue
    if (waitingUsers.length > 0) {
      const waitingUser = waitingUsers.shift();
      
      // Pair with new user
      connectedPairs.set(socket.id, waitingUser.id);
      connectedPairs.set(waitingUser.id, socket.id);
      
      socket.emit("connected");
      waitingUser.socket.emit("connected");
      
      userStats.totalConnections++;
    } else {
      waitingUsers.push({
        id: socket.id,
        socket: socket,
        joinedAt: Date.now()
      });
      socket.emit("searching");
    }
  });
  
  // Handle report
  socket.on("report", (data) => {
    const { reason } = data;
    const partnerId = findPartner(socket.id);
    
    console.log(`Report from ${socket.id} against ${partnerId}: ${reason}`);
    
    // Log the report (in production, save to database)
    console.log(`REPORT: User ${socket.id} reported ${partnerId} for: ${reason}`);
    
    // Disconnect the pair
    disconnectPair(socket.id);
    
    // In production, you might want to implement temporary bans
    // or other moderation features here
  });
  
  // Handle ping for connection quality
  socket.on("ping", () => {
    socket.emit("pong");
  });
  
  // Handle disconnect
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    userStats.activeUsers--;
    
    // Remove from waiting queue
    removeFromWaiting(socket.id);
    
    // Disconnect pair if connected
    disconnectPair(socket.id);
  });
});

// REST API endpoints for stats
app.get("/api/stats", (req, res) => {
  res.json({
    onlineUsers: userStats.activeUsers,
    totalChats: userStats.totalConnections,
    totalMessages: userStats.totalMessages,
    waitingUsers: waitingUsers.length
  });
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Cleanup function for stale waiting users
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  
  waitingUsers = waitingUsers.filter(user => {
    const isStale = (now - user.joinedAt) > timeout;
    if (isStale) {
      console.log(`Removing stale user: ${user.id}`);
      user.socket.emit("error", { 
        type: "timeout",
        message: "Connection timeout" 
      });
    }
    return !isStale;
  });
}, 60000); // Check every minute

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Stats API: http://localhost:${PORT}/api/stats`);
});
