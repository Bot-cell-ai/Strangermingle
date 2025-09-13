const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let waitingUser = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  if (waitingUser) {
    // Pair two users
    io.to(waitingUser).emit("partner-connected", socket.id);
    io.to(socket.id).emit("partner-connected", waitingUser);
    waitingUser = null;
  } else {
    waitingUser = socket.id;
  }

  socket.on("message", (data) => {
    io.to(data.to).emit("message", { from: socket.id, text: data.text });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    if (waitingUser === socket.id) {
      waitingUser = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
