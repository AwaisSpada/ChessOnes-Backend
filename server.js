

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { createServer } = require("http");
const { Server } = require("socket.io");
const User = require("./models/User");
const Game = require("./models/Game");
const GameInvitation = require("./models/GameInvitation");
const Stats = require("./models/Stats");
require("dotenv").config();

const app = express();

// ✅ Fix: trust proxy so express-rate-limit works on Render
app.set("trust proxy", 1);

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || "https://chessones-frontend-v2.vercel.app",
      "https://chessones-frontend-v2.vercel.app", // Current production frontend
      "https://chessones.com",
      "https://www.chessones.com",
      "http://localhost:3000", // allow local dev
      "http://localhost:3001",
      "http://localhost:3002",
      "http://localhost:3003",
      "http://localhost:3004",
      "http://localhost:3005", // allow local dev
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);

console.log("Allowed origin (Socket.io):", process.env.FRONTEND_URL);

// CORS configuration - must be before helmet to work properly
const allowedOrigins = [
  process.env.FRONTEND_URL || "https://chessones-frontend-v2.vercel.app",
  "https://chessones-frontend-v2.vercel.app",
  "https://chessones.com",
  "https://www.chessones.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:3004",
  "http://localhost:3005",
];

console.log("Allowed CORS origins:", allowedOrigins);

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      
      // Check if origin is in allowed list
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        // Log rejected origin for debugging
        console.log("CORS rejected origin:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: ["Content-Type", "Authorization"],
  })
);

// Security middleware (after CORS)
// Configure helmet to allow CORS - disable crossOriginEmbedderPolicy only
app.use(helmet({
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting
// NOTE:
// - The original limit (100 requests / 15min per IP) was too low for active chess games
//   and could trigger "Too many requests, please try again later." during normal play.
// - We relax this limit so gameplay (moves, bot calls, stats updates) does not trip it.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Allow much higher throughput per IP; can be overridden via env if needed
  max: parseInt(process.env.RATE_LIMIT_MAX || "1000", 10),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// MongoDB connection
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/chessones";
console.log("🔌 Connecting to MongoDB:", mongoUri.replace(/\/\/.*@/, "//***:***@")); // Hide credentials
mongoose
  .connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ MongoDB connected successfully");
    // Verify puzzle count on connection
    const Puzzle = require("./models/Puzzle");
    Puzzle.countDocuments().then((count) => {
      console.log(`📊 Puzzles in database: ${count}`);
    }).catch((err) => {
      console.error("Error counting puzzles:", err);
    });
  })
  .catch((err) => console.error("MongoDB connection error:", err));

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/games", require("./routes/games"));
app.use("/api/friends", require("./routes/friends"));
app.use("/api/stats", require("./routes/stats"));
app.use("/api/bot", require("./routes/bot")); // legacy simple bot endpoints
app.use("/api/bots", require("./routes/bots")); // new Bot definitions for Bot Battles
app.use("/api/bot-games", require("./routes/bot-games")); // Bot game creation
app.use("/api/invitations", require("./routes/invitations"));
app.use("/api/game-review", require("./routes/game-review")); // Game review analysis
app.use("/api/puzzles", require("./routes/puzzles")); // Puzzles endpoints
app.use("/api/admin", require("./routes/admin")); // Admin panel routes
app.use("/api/public", require("./routes/public")); // Contact + newsletter (public, uses sendMail)

// Socket.io for real-time features
const onlineUsers = new Map();
// Track which sockets have joined each game room to avoid resetting ready state on duplicate joins
const gameRoomSockets = new Map(); // gameId -> Set of socket IDs
// Track which users (by userId) are in each game room for presence sync
const gameRoomUsers = new Map(); // gameId -> Set of userIds
// Track per-game ready state in memory: Map<gameId, { [userId]: boolean }>
const gameReadyState = new Map();

// ========== MATCHMAKING SYSTEM ==========
// Matchmaking pool: Array of { userId, socketId, category, rating, timeControl: { initialTime, increment }, joinedAt, initialRating, timeoutSent }
const matchmakingPool = [];
// Map userId -> socketId for quick lookup
const matchmakingSockets = new Map(); // userId -> socketId

/**
 * Get dynamic rating range based on time in queue
 * Tiered scaling:
 * - 0-15 seconds: ±100 rating points
 * - 15-30 seconds: ±200 rating points
 * - 30-45 seconds: ±500 rating points
 */
function getDynamicRange(timeInQueueMs) {
  const elapsedSeconds = timeInQueueMs / 1000;
  
  if (elapsedSeconds < 15) {
    return 100;
  } else if (elapsedSeconds < 30) {
    return 200;
  } else if (elapsedSeconds < 45) {
    return 500;
  } else {
    // After 45 seconds, still return 500 (timeout will be handled separately)
    return 500;
  }
}

/**
 * Check if two players can be matched based on rating, category, and exact time control
 */
function canMatch(player1, player2) {
  // Must have same category
  if (player1.category !== player2.category) return false;
  
  // Must have EXACT same time control (initialTime and increment)
  if (!player1.timeControl || !player2.timeControl) {
    console.warn(`[Matchmaking] Missing timeControl for matching:`, {
      player1: !!player1.timeControl,
      player2: !!player2.timeControl,
    });
    return false;
  }
  
  if (player1.timeControl.initialTime !== player2.timeControl.initialTime) {
    return false;
  }
  
  if (player1.timeControl.increment !== player2.timeControl.increment) {
    return false;
  }
  
  // Check rating within dynamic range
  const timeInQueue1 = Date.now() - player1.joinedAt;
  const timeInQueue2 = Date.now() - player2.joinedAt;
  
  const range1 = getDynamicRange(timeInQueue1);
  const range2 = getDynamicRange(timeInQueue2);
  const maxRange = Math.max(range1, range2);
  
  const ratingDiff = Math.abs(player1.rating - player2.rating);
  return ratingDiff <= maxRange;
}

async function ensurePoliciesAcceptedForUser(userId) {
  if (!userId) return false;
  const user = await User.findById(userId).select("hasAcceptedPolicies").lean();
  return !!(user && user.hasAcceptedPolicies === true);
}

/**
 * Create a rated multiplayer game for two matched players
 * Uses the exact time control selected by the players
 */
async function createMatchmakingGame(player1, player2, category) {
  try {
    const Game = require("./models/Game");
    const User = require("./models/User");
    const { setGameCategory } = require("./services/ratingEngine");
    
    const player1Allowed = await ensurePoliciesAcceptedForUser(player1.userId);
    const player2Allowed = await ensurePoliciesAcceptedForUser(player2.userId);
    if (!player1Allowed || !player2Allowed) {
      throw new Error("Policy acknowledgment required for both players");
    }

    // Use the time control from the matched players (they should have the same one)
    const timeControl = player1.timeControl || player2.timeControl;
    
    if (!timeControl || !timeControl.initialTime) {
      throw new Error("Time control missing from player data");
    }
    
    // Generate unique game ID
    const gameId = Math.random().toString(36).substr(2, 9);
    
    // Create game with the selected time control
    const game = new Game({
      gameId: gameId,
      type: "multiplayer", // Rated multiplayer game
      isRated: true,
      players: {
        white: player1.userId,
        black: player2.userId,
      },
      timeControl: {
        initial: timeControl.initialTime, // in milliseconds
        increment: timeControl.increment || 0, // in milliseconds
      },
      timeRemaining: {
        white: timeControl.initialTime,
        black: timeControl.initialTime,
      },
      currentTurn: "white",
      status: "active",
    });
    
    // Set category based on time control
    setGameCategory(game);
    await game.save();
    
    // Update user statuses
    await User.findByIdAndUpdate(player1.userId, { status: "in-game" });
    await User.findByIdAndUpdate(player2.userId, { status: "in-game" });
    
    console.log(`[Matchmaking] Created game ${gameId} for players ${player1.userId} and ${player2.userId}`, {
      timeControl: game.timeControl,
      category: game.category,
    });
    
    return game;
  } catch (error) {
    console.error("[Matchmaking] Error creating game:", error);
    throw error;
  }
}

/**
 * Matchmaking loop - runs every 2 seconds
 */
setInterval(() => {
  // Always check for timeouts, even if pool has < 2 players
  const now = Date.now();
  const playersToRemove = [];
  
  matchmakingPool.forEach((player) => {
    const timeInQueue = now - player.joinedAt;
    const elapsedSeconds = timeInQueue / 1000;
    const currentRange = getDynamicRange(timeInQueue);
    
    // Log every 5 seconds for debugging
    if (Math.floor(elapsedSeconds) % 5 === 0 && elapsedSeconds < 45) {
      console.log(`[Matchmaking] User ${player.userId} waiting for ${elapsedSeconds.toFixed(1)}s. Current Range: ±${currentRange}`);
    }
    
    // After 45 seconds, trigger timeout and remove from pool
    if (elapsedSeconds >= 45) {
      // Check if timeout event already sent (prevent duplicates)
      if (!player.timeoutSent) {
        player.timeoutSent = true;
        
        // Try to emit to socket directly
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
          socket.emit("MATCHMAKING_TIMEOUT", {
            category: player.category,
            rating: player.rating,
            timeInQueue: timeInQueue,
          });
          console.log(`[Matchmaking] ⏰ Timeout sent to player ${player.userId} via socket ${player.socketId} after ${elapsedSeconds.toFixed(1)}s`);
        } else {
          console.warn(`[Matchmaking] ⚠️ Socket ${player.socketId} not found for player ${player.userId}, trying user room...`);
        }
        
        // Fallback: Also emit to user room
        io.to(`user:${player.userId}`).emit("MATCHMAKING_TIMEOUT", {
          category: player.category,
          rating: player.rating,
          timeInQueue: timeInQueue,
        });
        console.log(`[Matchmaking] ⏰ Timeout also sent to user room user:${player.userId} after ${elapsedSeconds.toFixed(1)}s`);
        
        // Mark for removal from pool
        playersToRemove.push(player.userId);
      }
    }
  });
  
  // Remove players who have timed out
  playersToRemove.forEach((userId) => {
    const index = matchmakingPool.findIndex(p => p.userId === userId);
    if (index !== -1) {
      matchmakingPool.splice(index, 1);
      matchmakingSockets.delete(userId);
      console.log(`[Matchmaking] Removed player ${userId} from pool after timeout`);
    }
  });
  
  // Only try to match if we have at least 2 players
  if (matchmakingPool.length < 2) return;
  
  // Sort by joinedAt (oldest first) for fair matching
  const sortedPool = [...matchmakingPool].sort((a, b) => a.joinedAt - b.joinedAt);
  
  // Try to match players
  for (let i = 0; i < sortedPool.length; i++) {
    const player1 = sortedPool[i];
    
    // Skip if player1 is already matched (removed from pool)
    if (!matchmakingPool.find(p => p.userId === player1.userId)) continue;
    
    for (let j = i + 1; j < sortedPool.length; j++) {
      const player2 = sortedPool[j];
      
      // Skip if player2 is already matched
      if (!matchmakingPool.find(p => p.userId === player2.userId)) continue;
      
      // Check if they can be matched
      if (canMatch(player1, player2)) {
        // Remove both from pool
        const index1 = matchmakingPool.findIndex(p => p.userId === player1.userId);
        const index2 = matchmakingPool.findIndex(p => p.userId === player2.userId);
        
        if (index1 !== -1) matchmakingPool.splice(index1, 1);
        if (index2 !== -1 && index2 !== index1) matchmakingPool.splice(index2 > index1 ? index2 - 1 : index2, 1);
        
        matchmakingSockets.delete(player1.userId);
        matchmakingSockets.delete(player2.userId);
        
        // Create game
        createMatchmakingGame(player1, player2, player1.category)
          .then((game) => {
            // Emit MATCH_FOUND to both players
            const socket1 = io.sockets.sockets.get(player1.socketId);
            const socket2 = io.sockets.sockets.get(player2.socketId);
            
            if (socket1) {
              socket1.emit("MATCH_FOUND", {
                gameId: game.gameId,
                opponent: {
                  userId: player2.userId,
                  rating: player2.rating,
                  category: player2.category,
                },
              });
            }
            
            if (socket2) {
              socket2.emit("MATCH_FOUND", {
                gameId: game.gameId,
                opponent: {
                  userId: player1.userId,
                  rating: player1.rating,
                  category: player1.category,
                },
              });
            }
            
            console.log(`[Matchmaking] Matched players ${player1.userId} and ${player2.userId} - Game ${game.gameId}`);
          })
          .catch((error) => {
            console.error("[Matchmaking] Failed to create game:", error);
            // Re-add players to pool on error
            if (!matchmakingPool.find(p => p.userId === player1.userId)) {
              matchmakingPool.push(player1);
              matchmakingSockets.set(player1.userId, player1.socketId);
            }
            if (!matchmakingPool.find(p => p.userId === player2.userId)) {
              matchmakingPool.push(player2);
              matchmakingSockets.set(player2.userId, player2.socketId);
            }
          });
        
        // Break inner loop after finding a match
        break;
      }
    }
  }
}, 2000); // Run every 2 seconds for more responsive updates

/**
 * Helper function to remove player from matchmaking pool
 */
function removeFromMatchmaking(userId) {
  const index = matchmakingPool.findIndex(p => p.userId === userId);
  if (index !== -1) {
    matchmakingPool.splice(index, 1);
    matchmakingSockets.delete(userId);
    console.log(`[Matchmaking] Player ${userId} left queue. Pool size: ${matchmakingPool.length}`);
  }
}

// ========== END MATCHMAKING SYSTEM ==========

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register-user", async (userId) => {
    if (!userId) return;
    
    // Check if user is suspended
    try {
      const user = await User.findById(userId);
      if (user && user.isSuspended) {
        socket.emit("ACCOUNT_SUSPENDED", {
          message: "Your account has been suspended by an administrator",
        });
        socket.disconnect(true);
        return;
      }
    } catch (err) {
      console.error("Error checking user suspension:", err);
    }
    
    socket.data.userId = userId;
    socket.join(`user:${userId}`);

    const sockets = onlineUsers.get(userId) || new Set();
    sockets.add(socket.id);
    onlineUsers.set(userId, sockets);
    console.log(`✅ User ${userId} registered socket ${socket.id}`);
    console.log(`   - Joined room: user:${userId}`);

    // Update DB status and notify friends via presence socket event
    try {
      await User.findByIdAndUpdate(userId, {
        status: "online",
        lastActive: new Date(),
      }).exec();

      const userDoc = await User.findById(userId).select("friends").lean();
      if (userDoc?.friends?.length) {
        userDoc.friends.forEach((friendId) => {
          io.to(`user:${friendId.toString()}`).emit("presence:update", {
            userId,
            status: "online",
          });
        });
      }
    } catch (err) {
      console.error("Presence register-user error:", err);
    }
  });

  socket.on("join-game", (gameId) => {
    if (!gameId) return;

    // Track which sockets have joined this game
    if (!gameRoomSockets.has(gameId)) {
      gameRoomSockets.set(gameId, new Set());
    }
    if (!gameRoomUsers.has(gameId)) {
      gameRoomUsers.set(gameId, new Set());
    }

    const socketSet = gameRoomSockets.get(gameId);
    const userSet = gameRoomUsers.get(gameId);
    const isNewJoin = !socketSet.has(socket.id);

    socket.join(gameId);
    socketSet.add(socket.id);

    console.log(
      `User ${socket.id} joined game ${gameId} (new join: ${isNewJoin})`
    );

    // If we have a userId, track it and sync presence
    if (socket.data.userId) {
      const userId = socket.data.userId.toString();
      const wasUserAlreadyTracked = userSet.has(userId);

      if (!wasUserAlreadyTracked) {
        userSet.add(userId);
      }

      // If this is a new join, sync presence both ways
      if (isNewJoin) {
        // 1. Tell the new joiner who's already in the room
        const existingUserIds = Array.from(userSet).filter(
          (uid) => uid !== userId
        );

        if (existingUserIds.length > 0) {
          console.log(
            `📢 Notifying new joiner ${userId} about existing players:`,
            existingUserIds
          );
          // Emit to the new joiner for each existing player
          existingUserIds.forEach((existingUserId) => {
            socket.emit("player-joined", {
              gameId,
              userId: existingUserId,
            });
          });
        }

        // 2. Tell existing players that the new joiner arrived
        socket.to(gameId).emit("player-joined", {
          gameId,
          userId: userId,
        });
      }
    }

    // Don't reset ready state on join-game - only reset on actual disconnect/reconnect
    // This prevents the ready state from being reset when the frontend effect runs multiple times
  });

  // ========== MATCHMAKING SOCKET HANDLERS ==========
  
  // Join matchmaking queue
  socket.on("JOIN_MATCHMAKING", async (payload) => {
    try {
      const { userId, rating, category, timeControl } = payload || {};
      
      if (!userId || !rating || !category) {
        socket.emit("MATCHMAKING_ERROR", {
          message: "Missing required fields: userId, rating, category",
        });
        return;
      }

      const hasAcceptedPolicies = await ensurePoliciesAcceptedForUser(userId);
      if (!hasAcceptedPolicies) {
        socket.emit("MATCHMAKING_ERROR", {
          code: "POLICY_ACCEPTANCE_REQUIRED",
          message:
            "Policy acknowledgment is required before entering matchmaking.",
        });
        return;
      }
      
      // Validate timeControl
      if (!timeControl || typeof timeControl.initialTime !== 'number' || typeof timeControl.increment !== 'number') {
        socket.emit("MATCHMAKING_ERROR", {
          message: "Missing or invalid timeControl. Must include initialTime and increment (in milliseconds)",
        });
        console.error(`[Matchmaking] Invalid timeControl received:`, timeControl);
        return;
      }
      
      // Normalize and validate category (case-insensitive)
      const normalizedCategory = category?.toLowerCase().trim();
      if (!["bullet", "blitz", "rapid"].includes(normalizedCategory)) {
        socket.emit("MATCHMAKING_ERROR", {
          message: "Invalid category. Must be 'bullet', 'blitz', or 'rapid'",
        });
        console.error(`[Matchmaking] Invalid category received: "${category}" (normalized: "${normalizedCategory}")`);
        return;
      }
      
      // Remove user from pool if already in (prevent duplicates)
      const existingIndex = matchmakingPool.findIndex(p => p.userId === userId);
      if (existingIndex !== -1) {
        matchmakingPool.splice(existingIndex, 1);
        matchmakingSockets.delete(userId);
        console.log(`[Matchmaking] Removed duplicate entry for user ${userId}`);
      }
      
      // Add to matchmaking pool with time control
      const player = {
        userId: userId.toString(),
        socketId: socket.id,
        category: normalizedCategory, // Use normalized category
        rating: rating,
        timeControl: {
          initialTime: timeControl.initialTime, // in milliseconds
          increment: timeControl.increment, // in milliseconds
        },
        joinedAt: Date.now(),
        initialRating: rating,
        timeoutSent: false,
      };
      
      console.log(`[Matchmaking] ✅ Player ${userId} joined queue:`, {
        socketId: socket.id,
        category: normalizedCategory,
        rating: rating,
        timeControl: player.timeControl,
        poolSize: matchmakingPool.length + 1,
      });
      
      matchmakingPool.push(player);
      matchmakingSockets.set(userId.toString(), socket.id);
      
      socket.emit("MATCHMAKING_JOINED", {
        category: normalizedCategory,
        rating,
        queuePosition: matchmakingPool.length,
        timeControl: player.timeControl,
      });
    } catch (error) {
      console.error("[Matchmaking] JOIN_MATCHMAKING error:", error);
      socket.emit("MATCHMAKING_ERROR", {
        message: "Failed to join matchmaking queue",
      });
    }
  });
  
  // Leave matchmaking queue
  socket.on("LEAVE_MATCHMAKING", (payload) => {
    try {
      const { userId } = payload || {};
      
      if (!userId) {
        // Try to get userId from socket data
        const socketUserId = socket.data.userId;
        if (socketUserId) {
          removeFromMatchmaking(socketUserId.toString());
        }
        return;
      }
      
      removeFromMatchmaking(userId.toString());
    } catch (error) {
      console.error("[Matchmaking] LEAVE_MATCHMAKING error:", error);
    }
  });
  
  // ========== END MATCHMAKING SOCKET HANDLERS ==========

  // Explicitly leave a game without closing the WebSocket connection.
  // This is used when a user navigates away from a game screen but stays online.
  socket.on("leave-game", async (payload) => {
    try {
      const { gameId, userId } = payload || {};
      if (!gameId || !userId) return;

      // Remove this socket from the game room tracking set
      const socketSet = gameRoomSockets.get(gameId);
      if (socketSet && socketSet.has(socket.id)) {
        socketSet.delete(socket.id);
        if (socketSet.size === 0) {
          gameRoomSockets.delete(gameId);
        }
      }

      // Check if this user has any other sockets in this game room
      const userSet = gameRoomUsers.get(gameId);
      if (userSet) {
        // Check all sockets in this game room to see if any belong to this userId
        let hasOtherSockets = false;
        if (socketSet && socketSet.size > 0) {
          for (const otherSocketId of socketSet) {
            const otherSocket = io.sockets.sockets.get(otherSocketId);
            if (
              otherSocket &&
              otherSocket.data.userId &&
              otherSocket.data.userId.toString() === userId.toString()
            ) {
              hasOtherSockets = true;
              break;
            }
          }
        }

        // Only remove userId if no other sockets for this user remain in the room
        if (!hasOtherSockets) {
          userSet.delete(userId.toString());
          if (userSet.size === 0) {
            gameRoomUsers.delete(gameId);
          }
        }
      }

      socket.leave(gameId);

      // Notify remaining players in this game that a player left the board
      io.to(gameId).emit("player-disconnected", {
        gameId,
        userId,
      });

      console.log(
        `👋 User ${userId} (socket ${socket.id}) left game ${gameId} via leave-game`
      );
    } catch (err) {
      console.error("leave-game socket handler error:", err);
    }
  });

  socket.on("player-ready", (payload) => {
    try {
      const { gameId, userId, ready } = payload || {};
      if (!gameId || !userId) return;

      const current = gameReadyState.get(gameId) || {};
      current[userId] = !!ready;
      gameReadyState.set(gameId, current);

      const readyValues = Object.values(current);
      const allReady =
        readyValues.length >= 2 && readyValues.every((val) => val === true);

      io.to(gameId).emit("ready:update", {
        gameId,
        userId,
        ready: !!ready,
        state: current,
        allReady,
      });
    } catch (err) {
      console.error("player-ready socket handler error:", err);
    }
  });

  socket.on("make-move", (data) => {
    if (!data?.gameId) return;
    socket.to(data.gameId).emit("move-made", data);
  });

  // Chat handlers
  socket.on("chat:send", (data) => {
    try {
      const { gameId, message, senderId, timestamp } = data || {};
      
      if (!gameId || !message || !senderId) {
        console.error("[Chat] Missing required fields:", { gameId, message, senderId });
        return;
      }

      // Validate message length
      if (message.trim().length === 0) {
        console.error("[Chat] Empty message received");
        return;
      }

      if (message.length > 500) {
        console.error("[Chat] Message too long:", message.length);
        return;
      }

      // Broadcast message to all users in the game room
      const chatData = {
        gameId,
        message: message.trim(),
        senderId,
        timestamp: timestamp || new Date().toISOString(),
      };

      console.log(`[Chat] Broadcasting message to game ${gameId}:`, {
        senderId,
        messageLength: message.length,
      });

      io.to(gameId).emit("chat:receive", chatData);
    } catch (error) {
      console.error("[Chat] Error handling chat:send:", error);
    }
  });

  // Draw request handlers are now handled via API endpoints in routes/games.js
  // WebSocket events are emitted from the API endpoints after database operations

  socket.on("watch-invite", (token) => {
    if (!token) return;
    socket.join(`invite:${token}`);
  });

  socket.on("unwatch-invite", (token) => {
    if (!token) return;
    socket.leave(`invite:${token}`);
  });

  // Handle sending invitation via WebSocket
  socket.on("send-invite", async (payload) => {
    try {
      const { friendId, gameType, timeControl, matchType } = payload || {};
      if (!friendId) {
        socket.emit("invite-error", {
          message: "Friend ID is required",
        });
        return;
      }
      if (!socket.data.userId) {
        socket.emit("invite-error", {
          message: "User not registered. Please reconnect.",
        });
        return;
      }

      const GameInvitation = require("./models/GameInvitation");
      const Game = require("./models/Game");
      const User = require("./models/User");
      const crypto = require("crypto");

      const sender = await User.findById(socket.data.userId);
      const opponent = await User.findById(friendId);

      if (!sender) {
        socket.emit("invite-error", {
          message: "Sender not found",
        });
        return;
      }
      if (!opponent) {
        socket.emit("invite-error", {
          message: "Friend not found",
        });
        return;
      }

      if (sender.hasAcceptedPolicies !== true) {
        socket.emit("invite-error", {
          code: "POLICY_ACCEPTANCE_REQUIRED",
          message:
            "Policy acknowledgment is required before sending challenges.",
        });
        return;
      }

      // Check for existing pending invitation
      const existingPending = await GameInvitation.findOne({
        fromUser: sender._id,
        toUser: opponent._id,
        status: "pending",
        expiresAt: { $gt: new Date() },
      });

      if (existingPending) {
        socket.emit("invite-error", {
          message: "You already have a pending challenge to this user",
        });
        return;
      }

      // Create game
      const gameId = Math.random().toString(36).substr(2, 9);
      const DEFAULT_TIME_CONTROLS = {
        bullet: { initial: 60000, increment: 1000 },
        blitz: { initial: 180000, increment: 2000 },
        rapid: { initial: 600000, increment: 0 },
        classical: { initial: 900000, increment: 10000 },
      };
      const normalizedGameType = gameType?.toLowerCase() || "blitz";
      const normalizedMatchType =
        matchType === "unrated" || matchType === "casual" ? "unrated" : "rated";
      const isRated = normalizedMatchType === "rated";
      const resolvedTimeControl =
        timeControl ||
        DEFAULT_TIME_CONTROLS[normalizedGameType] ||
        DEFAULT_TIME_CONTROLS.blitz;

      const { setGameCategory } = require("./services/ratingEngine");
      
      const game = new Game({
        gameId: gameId,
        type: "friend",
        isRated,
        players: {
          white: sender._id,
          black: opponent._id,
        },
        timeControl: resolvedTimeControl,
        timeRemaining: {
          white: resolvedTimeControl.initial,
          black: resolvedTimeControl.initial,
        },
        status: "active",
      });
      
      // Set category based on time control
      setGameCategory(game);
      await game.save();

      // Create invitation
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      const invitation = await GameInvitation.create({
        token,
        fromUser: sender._id,
        toUser: opponent._id,
        toEmail: opponent.email,
        gameType: normalizedGameType,
        matchType: normalizedMatchType,
        timeControl: resolvedTimeControl,
        expiresAt,
        gameId: gameId,
      });

      await invitation.populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
        { path: "toUser", select: "username fullName avatar rating country" },
      ]);

      const formatted = {
        id: invitation._id,
        token: invitation.token,
        status: invitation.status,
        gameType: invitation.gameType,
        matchType: invitation.matchType || "rated",
        timeControl: invitation.timeControl,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        gameId: invitation.gameId,
        from: {
          id: invitation.fromUser._id,
          username: invitation.fromUser.username,
          fullName: invitation.fromUser.fullName,
          rating: invitation.fromUser.rating,
          avatar: invitation.fromUser.avatar,
        },
        to: {
          id: invitation.toUser._id,
          username: invitation.toUser.username,
          fullName: invitation.toUser.fullName,
          rating: invitation.toUser.rating,
          avatar: invitation.toUser.avatar,
        },
      };

      // Emit to recipient
      io.to(`user:${opponent._id.toString()}`).emit(
        "challenge:incoming",
        formatted
      );

      // Emit confirmation to sender
      socket.emit("invite-sent", formatted);

      console.log(
        `✅ Invitation sent via WebSocket: ${token} from ${sender._id} to ${opponent._id}`
      );
    } catch (err) {
      console.error("send-invite socket handler error:", err);
      socket.emit("invite-error", {
        message: "Failed to send invitation",
        error: err.message,
      });
    }
  });

  // Handle accepting invitation via WebSocket
  socket.on("accept-invite", async (payload) => {
    try {
      const { token } = payload || {};
      if (!token || !socket.data.userId) return;

      const currentUserAllowed = await ensurePoliciesAcceptedForUser(
        socket.data.userId
      );
      if (!currentUserAllowed) {
        socket.emit("invite-error", {
          code: "POLICY_ACCEPTANCE_REQUIRED",
          message:
            "Policy acknowledgment is required before accepting invitations.",
        });
        return;
      }

      // ---------------------------
      // Rematch tokens support (rematch_<RematchRequestId>)
      // ---------------------------
      if (typeof token === "string" && token.startsWith("rematch_")) {
        const RematchRequest = require("./models/RematchRequest");
        const Game = require("./models/Game");

        const rematchId = token.replace("rematch_", "");
        const rematchRequest = await RematchRequest.findById(rematchId).populate([
          { path: "fromUser", select: "username fullName avatar rating country" },
          { path: "toUser", select: "username fullName avatar rating country" },
        ]);

        if (!rematchRequest) {
          socket.emit("invite-error", { message: "Invitation not found" });
          return;
        }

        // Only the recipient can accept
        if (
          rematchRequest.toUser?._id?.toString() !== socket.data.userId?.toString()
        ) {
          socket.emit("invite-error", {
            message: "You are not allowed to accept this invite",
          });
          return;
        }

        if (rematchRequest.status !== "pending") {
          socket.emit("invite-error", {
            message: `Invitation already ${rematchRequest.status}`,
          });
          return;
        }
        const rematchExpiresAt = new Date(
          new Date(rematchRequest.createdAt).getTime() + 24 * 60 * 60 * 1000
        );
        if (rematchExpiresAt < new Date()) {
          rematchRequest.status = "expired";
          await rematchRequest.save();
          socket.emit("invite-error", { message: "Invitation has expired" });
          return;
        }

        // Load original game
        const originalGameId = rematchRequest.originalGameId;
        const originalGame = await Game.findOne({ gameId: originalGameId });
        if (!originalGame) {
          socket.emit("invite-error", { message: "Game not found" });
          return;
        }

        // Create new game with swapped colors (same time control)
        const { setGameCategory } = require("./services/ratingEngine");
        const newGameId = Math.random().toString(36).substr(2, 9);
        const newGame = new Game({
          gameId: newGameId,
          type: "friend",
          isRated: originalGame.isRated !== false,
          players: {
            white: originalGame.players.black,
            black: originalGame.players.white,
          },
          timeControl: rematchRequest.timeControl || originalGame.timeControl,
          timeRemaining: {
            white:
              (rematchRequest.timeControl || originalGame.timeControl)?.initial ||
              300000,
            black:
              (rematchRequest.timeControl || originalGame.timeControl)?.initial ||
              300000,
          },
          status: "active",
        });
        setGameCategory(newGame);
        await newGame.save();

        // Mark rematch request accepted and store new gameId
        rematchRequest.status = "accepted";
        rematchRequest.gameId = newGameId;
        await rematchRequest.save();

        const formatted = {
          id: rematchRequest._id,
          token: `rematch_${rematchRequest._id}`,
          type: "rematch",
          status: "accepted",
          gameType: rematchRequest.gameType || "blitz",
          matchType: originalGame.isRated === false ? "unrated" : "rated",
          timeControl: rematchRequest.timeControl || originalGame.timeControl,
          gameId: newGameId,
          originalGameId,
          createdAt: rematchRequest.createdAt,
          from: rematchRequest.fromUser
            ? {
                id: rematchRequest.fromUser._id,
                username: rematchRequest.fromUser.username,
                fullName: rematchRequest.fromUser.fullName,
                rating: rematchRequest.fromUser.rating,
                avatar: rematchRequest.fromUser.avatar,
              }
            : null,
          to: rematchRequest.toUser
            ? {
                id: rematchRequest.toUser._id,
                username: rematchRequest.toUser.username,
                fullName: rematchRequest.toUser.fullName,
                rating: rematchRequest.toUser.rating,
                avatar: rematchRequest.toUser.avatar,
              }
            : null,
        };

        // Remove from notifications for both users
        io.to(`user:${rematchRequest.fromUser._id.toString()}`).emit(
          "challenge:update",
          formatted
        );
        io.to(`user:${rematchRequest.toUser._id.toString()}`).emit(
          "challenge:update",
          formatted
        );

        // Tell both clients to start the rematch (new game)
        const fromId = rematchRequest.fromUser._id.toString();
        const toId = rematchRequest.toUser._id.toString();
        const newWhiteId = originalGame.players.black?.toString();
        const newBlackId = originalGame.players.white?.toString();

        io.to(`user:${fromId}`).emit("rematch:start", {
          gameId: newGameId,
          newColor: fromId === newWhiteId ? "white" : "black",
        });
        io.to(`user:${toId}`).emit("rematch:start", {
          gameId: newGameId,
          newColor: toId === newWhiteId ? "white" : "black",
        });

        // Confirm to acceptor (keeps existing dashboard UX consistent)
        socket.emit("invite-accepted", {
          gameId: newGameId,
          invitation: formatted,
        });

        console.log(`✅ Rematch accepted via WebSocket: ${token} -> ${newGameId}`);
        return;
      }

      const GameInvitation = require("./models/GameInvitation");
      const Game = require("./models/Game");

      const invitation = await GameInvitation.findOne({ token }).populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
        { path: "toUser", select: "username fullName avatar rating country" },
      ]);

      if (!invitation) {
        socket.emit("invite-error", { message: "Invitation not found" });
        return;
      }

      if (!invitation.toUser._id.equals(socket.data.userId)) {
        socket.emit("invite-error", {
          message: "You are not allowed to accept this invite",
        });
        return;
      }

      if (invitation.status !== "pending") {
        socket.emit("invite-error", {
          message: `Invitation already ${invitation.status}`,
        });
        return;
      }

      if (invitation.expiresAt < new Date()) {
        invitation.status = "expired";
        await invitation.save();
        socket.emit("invite-error", { message: "Invitation has expired" });
        return;
      }

      const game = await Game.findOne({ gameId: invitation.gameId });
      if (!game) {
        socket.emit("invite-error", { message: "Game not found" });
        return;
      }
      if (["completed", "abandoned", "draw"].includes(String(game.status || "").toLowerCase())) {
        socket.emit("invite-error", { message: "Invitation is no longer actionable" });
        return;
      }

      invitation.status = "accepted";
      await invitation.save();

      const formatted = {
        id: invitation._id,
        token: invitation.token,
        status: invitation.status,
        gameType: invitation.gameType,
        matchType: invitation.matchType || "rated",
        timeControl: invitation.timeControl,
        gameId: game.gameId,
        from: {
          id: invitation.fromUser._id,
          username: invitation.fromUser.username,
          fullName: invitation.fromUser.fullName,
          rating: invitation.fromUser.rating,
          avatar: invitation.fromUser.avatar,
          country: invitation.fromUser.country || "",
        },
        to: {
          id: invitation.toUser._id,
          username: invitation.toUser.username,
          fullName: invitation.toUser.fullName,
          rating: invitation.toUser.rating,
          avatar: invitation.toUser.avatar,
          country: invitation.toUser.country || "",
        },
      };

      // Ensure the accepting user joins the game room
      const gameId = game.gameId;
      if (!gameRoomSockets.has(gameId)) {
        gameRoomSockets.set(gameId, new Set());
      }
      if (!gameRoomUsers.has(gameId)) {
        gameRoomUsers.set(gameId, new Set());
      }

      const socketSet = gameRoomSockets.get(gameId);
      const userSet = gameRoomUsers.get(gameId);

      socket.join(gameId);
      socketSet.add(socket.id);

      const acceptingUserId = invitation.toUser._id.toString();
      if (!userSet.has(acceptingUserId)) {
        userSet.add(acceptingUserId);
      }

      // Check if the sender is already in the room
      const senderId = invitation.fromUser._id.toString();
      const senderInRoom = userSet.has(senderId);

      // Notify sender that opponent joined
      io.to(`user:${invitation.fromUser._id.toString()}`).emit(
        "opponent-joined",
        {
          gameId: game.gameId,
          opponent: {
            id: invitation.toUser._id,
            username: invitation.toUser.username,
            fullName: invitation.toUser.fullName,
            avatar: invitation.toUser.avatar,
            rating: invitation.toUser.rating,
            country: invitation.toUser.country || "",
          },
        }
      );

      // Emit player-joined to game room (with userId + profile so clients can show flag before refetch)
      io.to(gameId).emit("player-joined", {
        gameId: game.gameId,
        userId: acceptingUserId,
        player: {
          id: invitation.toUser._id,
          username: invitation.toUser.username,
          fullName: invitation.toUser.fullName,
          avatar: invitation.toUser.avatar,
          rating: invitation.toUser.rating,
          country: invitation.toUser.country || "",
        },
      });

      // If sender is already in the room, notify the accepting user about the sender (incl. country for UI)
      if (senderInRoom) {
        socket.emit("player-joined", {
          gameId: game.gameId,
          userId: senderId,
          player: {
            id: invitation.fromUser._id,
            username: invitation.fromUser.username,
            fullName: invitation.fromUser.fullName,
            avatar: invitation.fromUser.avatar,
            rating: invitation.fromUser.rating,
            country: invitation.fromUser.country || "",
          },
        });
      }

      // Broadcast update to both users
      io.to(`user:${invitation.fromUser._id.toString()}`).emit(
        "challenge:update",
        formatted
      );
      io.to(`user:${invitation.toUser._id.toString()}`).emit(
        "challenge:update",
        formatted
      );

      // Confirm to acceptor
      socket.emit("invite-accepted", {
        gameId: game.gameId,
        invitation: formatted,
      });

      console.log(`✅ Invitation accepted via WebSocket: ${token}`);
    } catch (err) {
      console.error("accept-invite socket handler error:", err);
      socket.emit("invite-error", {
        message: "Failed to accept invitation",
        error: err.message,
      });
    }
  });

  // Handle declining invitation via WebSocket
  socket.on("decline-invite", async (payload) => {
    try {
      const { token } = payload || {};
      if (!token || !socket.data.userId) return;

      // ---------------------------
      // Rematch tokens support (rematch_<RematchRequestId>)
      // ---------------------------
      if (typeof token === "string" && token.startsWith("rematch_")) {
        const RematchRequest = require("./models/RematchRequest");

        const rematchId = token.replace("rematch_", "");
        const rematchRequest = await RematchRequest.findById(rematchId).populate([
          { path: "fromUser", select: "username fullName avatar rating country" },
          { path: "toUser", select: "username fullName avatar rating country" },
        ]);

        if (!rematchRequest) {
          socket.emit("invite-error", { message: "Invitation not found" });
          return;
        }

        // Only the recipient can decline
        if (
          rematchRequest.toUser?._id?.toString() !== socket.data.userId?.toString()
        ) {
          socket.emit("invite-error", {
            message: "You are not allowed to decline this invite",
          });
          return;
        }

        if (rematchRequest.status !== "pending") {
          socket.emit("invite-error", {
            message: `Invitation already ${rematchRequest.status}`,
          });
          return;
        }
        const rematchExpiresAt = new Date(
          new Date(rematchRequest.createdAt).getTime() + 24 * 60 * 60 * 1000
        );
        if (rematchExpiresAt < new Date()) {
          rematchRequest.status = "expired";
          await rematchRequest.save();
          socket.emit("invite-error", { message: "Invitation has expired" });
          return;
        }

        rematchRequest.status = "declined";
        await rematchRequest.save();

        const formatted = {
          id: rematchRequest._id,
          token: `rematch_${rematchRequest._id}`,
          type: "rematch",
          status: "declined",
          gameType: rematchRequest.gameType || "blitz",
          timeControl: rematchRequest.timeControl,
          gameId: rematchRequest.gameId || rematchRequest.originalGameId,
          originalGameId: rematchRequest.originalGameId,
          createdAt: rematchRequest.createdAt,
          from: rematchRequest.fromUser
            ? {
                id: rematchRequest.fromUser._id,
                username: rematchRequest.fromUser.username,
                fullName: rematchRequest.fromUser.fullName,
                rating: rematchRequest.fromUser.rating,
                avatar: rematchRequest.fromUser.avatar,
              }
            : null,
          to: rematchRequest.toUser
            ? {
                id: rematchRequest.toUser._id,
                username: rematchRequest.toUser.username,
                fullName: rematchRequest.toUser.fullName,
                rating: rematchRequest.toUser.rating,
                avatar: rematchRequest.toUser.avatar,
              }
            : null,
        };

        // Remove from notifications for both users
        io.to(`user:${rematchRequest.fromUser._id.toString()}`).emit(
          "challenge:update",
          formatted
        );
        io.to(`user:${rematchRequest.toUser._id.toString()}`).emit(
          "challenge:update",
          formatted
        );

        // Also notify requester (optional toast/banner listeners)
        io.to(`user:${rematchRequest.fromUser._id.toString()}`).emit(
          "rematch:declined",
          { gameId: rematchRequest.originalGameId, fromUserId: socket.data.userId }
        );

        // Confirm to decliner (keeps existing dashboard UX consistent)
        socket.emit("invite-declined", formatted);

        console.log(`✅ Rematch declined via WebSocket: ${token}`);
        return;
      }

      const GameInvitation = require("./models/GameInvitation");
      const Game = require("./models/Game");

      const invitation = await GameInvitation.findOne({ token }).populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
        { path: "toUser", select: "username fullName avatar rating country" },
      ]);

      if (!invitation) {
        socket.emit("invite-error", { message: "Invitation not found" });
        return;
      }

      if (!invitation.toUser._id.equals(socket.data.userId)) {
        socket.emit("invite-error", {
          message: "You are not allowed to decline this invite",
        });
        return;
      }
      if (invitation.status !== "pending") {
        socket.emit("invite-error", {
          message: `Invitation already ${invitation.status}`,
        });
        return;
      }
      if (invitation.expiresAt < new Date()) {
        invitation.status = "expired";
        await invitation.save();
        socket.emit("invite-error", { message: "Invitation has expired" });
        return;
      }

      invitation.status = "declined";
      await invitation.save();

      // Mark game as abandoned if it exists
      if (invitation.gameId) {
        const game = await Game.findOne({ gameId: invitation.gameId });
        if (game) {
          game.status = "abandoned";
          await game.save();
        }
      }

      const formatted = {
        id: invitation._id,
        token: invitation.token,
        status: invitation.status,
        gameType: invitation.gameType,
        timeControl: invitation.timeControl,
        gameId: invitation.gameId,
        from: {
          id: invitation.fromUser._id,
          username: invitation.fromUser.username,
          fullName: invitation.fromUser.fullName,
          rating: invitation.fromUser.rating,
          avatar: invitation.fromUser.avatar,
        },
        to: {
          id: invitation.toUser._id,
          username: invitation.toUser.username,
          fullName: invitation.toUser.fullName,
          rating: invitation.toUser.rating,
          avatar: invitation.toUser.avatar,
        },
      };

      // Broadcast update to both users
      io.to(`user:${invitation.fromUser._id.toString()}`).emit(
        "challenge:update",
        formatted
      );
      io.to(`user:${invitation.toUser._id.toString()}`).emit(
        "challenge:update",
        formatted
      );

      // Confirm to decliner
      socket.emit("invite-declined", formatted);

      console.log(`✅ Invitation declined via WebSocket: ${token}`);
    } catch (err) {
      console.error("decline-invite socket handler error:", err);
      socket.emit("invite-error", {
        message: "Failed to decline invitation",
        error: err.message,
      });
    }
  });

  // ========== REMATCH SYSTEM ==========
  // Handle rematch request
  socket.on("rematch:request", async (payload) => {
    try {
      const { gameId, senderId } = payload || {};
      if (!gameId || !senderId || !socket.data.userId) return;

      const senderAllowed = await ensurePoliciesAcceptedForUser(senderId);
      if (!senderAllowed) {
        socket.emit("rematch:error", {
          code: "POLICY_ACCEPTANCE_REQUIRED",
          message:
            "Policy acknowledgment is required before requesting rematches.",
        });
        return;
      }

      const Game = require("./models/Game");
      const game = await Game.findOne({ gameId })
        .populate("players.white players.black")
        .lean();

      if (!game) {
        socket.emit("rematch:error", { message: "Game not found" });
        return;
      }

      // Verify sender is part of the game
      const isWhite = game.players.white?._id?.toString() === senderId.toString();
      const isBlack = game.players.black?._id?.toString() === senderId.toString();
      if (!isWhite && !isBlack) {
        socket.emit("rematch:error", { message: "You are not part of this game" });
        return;
      }

      // Find opponent
      const opponentId = isWhite
        ? game.players.black?._id?.toString()
        : game.players.white?._id?.toString();

      if (!opponentId) {
        socket.emit("rematch:error", { message: "Opponent not found" });
        return;
      }

      // Create rematch request in database
      const RematchRequest = require("./models/RematchRequest");
      
      // Delete any existing pending rematch requests for this game
      await RematchRequest.deleteMany({
        originalGameId: gameId,
        status: "pending",
      });
      
      // Get time control from the game (reuse same time control)
      const timeControl = game.timeControl || { initial: 300000, increment: 3 };
      const gameType = game.gameType || "blitz";
      
      // Create new rematch request
      const rematchRequest = await RematchRequest.create({
        gameId: gameId, // Use same gameId for now, will be updated when accepted
        fromUser: senderId,
        toUser: opponentId,
        originalGameId: gameId,
        status: "pending",
        timeControl: timeControl,
        gameType: gameType,
      });
      
      await rematchRequest.populate([
        { path: "fromUser", select: "username fullName avatar rating country" },
      ]);
      
      // Format rematch request similar to challenge invitation
      const formattedRematch = {
        id: rematchRequest._id,
        token: `rematch_${rematchRequest._id}`,
        type: "rematch",
        gameType: rematchRequest.gameType || "blitz",
        timeControl: rematchRequest.timeControl || timeControl,
        gameId: gameId,
        originalGameId: gameId,
        status: "pending",
        createdAt: rematchRequest.createdAt,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours expiry
        from: rematchRequest.fromUser
          ? {
              id: rematchRequest.fromUser._id,
              username: rematchRequest.fromUser.username,
              fullName: rematchRequest.fromUser.fullName,
              rating: rematchRequest.fromUser.rating,
              avatar: rematchRequest.fromUser.avatar,
            }
          : null,
      };
      
      // Broadcast rematch request ONLY to opponent (not to sender)
      io.to(`user:${opponentId}`).emit("rematch:offered", {
        gameId,
        fromUserId: senderId,
      });
      
      // Also emit challenge:incoming event so it appears in notifications sidebar
      io.to(`user:${opponentId}`).emit("challenge:incoming", formattedRematch);
      
      // Also emit to the game room BUT exclude the sender's socket
      const opponentSockets = onlineUsers.get(opponentId);
      if (opponentSockets) {
        opponentSockets.forEach((socketId) => {
          const s = io.sockets.sockets.get(socketId);
          if (s && s.rooms.has(gameId)) {
            s.emit("rematch:offered", {
              gameId,
              fromUserId: senderId,
            });
          }
        });
      }

      console.log(`🔄 Rematch requested: ${gameId} by ${senderId} to ${opponentId}`);
    } catch (err) {
      console.error("rematch:request socket handler error:", err);
      socket.emit("rematch:error", {
        message: "Failed to request rematch",
        error: err.message,
      });
    }
  });

  // Handle rematch decline
  socket.on("rematch:decline", async (payload) => {
    try {
      const { gameId, senderId } = payload || {};
      if (!gameId || !senderId || !socket.data.userId) return;

      const Game = require("./models/Game");
      const game = await Game.findOne({ gameId })
        .populate("players.white players.black")
        .lean();

      if (!game) return;

      // Find opponent
      const isWhite = game.players.white?._id?.toString() === senderId.toString();
      const opponentId = isWhite
        ? game.players.black?._id?.toString()
        : game.players.white?._id?.toString();

      // Update rematch request status
      const RematchRequest = require("./models/RematchRequest");
      const rematchRequest = await RematchRequest.findOne({
        originalGameId: gameId,
        toUser: senderId,
        status: "pending",
      });
      
      if (rematchRequest) {
        rematchRequest.status = "declined";
        await rematchRequest.save();
      }
      
      if (opponentId) {
        // Notify opponent that rematch was declined
        io.to(`user:${opponentId}`).emit("rematch:declined", {
          gameId,
          fromUserId: senderId,
        });
        
        // Also emit challenge:update to remove from notifications
        io.to(`user:${opponentId}`).emit("challenge:update", {
          id: rematchRequest?._id,
          type: "rematch",
          status: "declined",
        });
      }

      console.log(`❌ Rematch declined: ${gameId} by ${senderId}`);
    } catch (err) {
      console.error("rematch:decline socket handler error:", err);
    }
  });

  // Handle rematch accept
  socket.on("rematch:accept", async (payload) => {
    try {
      const { gameId, senderId } = payload || {};
      if (!gameId || !senderId || !socket.data.userId) return;

      const senderAllowed = await ensurePoliciesAcceptedForUser(senderId);
      if (!senderAllowed) {
        socket.emit("rematch:error", {
          code: "POLICY_ACCEPTANCE_REQUIRED",
          message:
            "Policy acknowledgment is required before accepting rematches.",
        });
        return;
      }

      const Game = require("./models/Game");
      const User = require("./models/User");
      const game = await Game.findOne({ gameId })
        .populate("players.white players.black")
        .exec();

      if (!game) {
        socket.emit("rematch:error", { message: "Game not found" });
        return;
      }

      // Verify sender is part of the game
      const isWhite = game.players.white?._id?.toString() === senderId.toString();
      const isBlack = game.players.black?._id?.toString() === senderId.toString();
      if (!isWhite && !isBlack) {
        socket.emit("rematch:error", { message: "You are not part of this game" });
        return;
      }

      // Get opponent
      const opponentId = isWhite
        ? game.players.black?._id?.toString()
        : game.players.white?._id?.toString();

      if (!opponentId) {
        socket.emit("rematch:error", { message: "Opponent not found" });
        return;
      }

      // Update rematch request status
      const RematchRequest = require("./models/RematchRequest");
      const rematchRequest = await RematchRequest.findOne({
        originalGameId: gameId,
        fromUser: isWhite ? game.players.white?._id : game.players.black?._id,
        toUser: isWhite ? game.players.black?._id : game.players.white?._id,
        status: "pending",
      });
      
      // Create new game with SWAPPED colors
      const { setGameCategory } = require("./services/ratingEngine");
      const newGameId = Math.random().toString(36).substr(2, 9);
      const newGame = new Game({
        gameId: newGameId,
        type: "friend",
        players: {
          // Swap colors: previous white becomes black, previous black becomes white
          white: isWhite ? opponentId : senderId,   // If sender was white, opponent becomes white; if sender was black, sender becomes white
          black: isWhite ? senderId : opponentId,   // If sender was white, sender becomes black; if sender was black, opponent becomes black
        },
        timeControl: game.timeControl,
        timeRemaining: {
          white: game.timeControl.initial,
          black: game.timeControl.initial,
        },
        status: "active",
      });
      setGameCategory(newGame);
      await newGame.save();
      
      // Update rematch request status and new gameId
      if (rematchRequest) {
        rematchRequest.status = "accepted";
        rematchRequest.gameId = newGameId; // Update with new gameId
        await rematchRequest.save();
        
        // Emit challenge:update to remove from notifications
        io.to(`user:${opponentId}`).emit("challenge:update", {
          id: rematchRequest._id,
          token: `rematch_${rematchRequest._id}`,
          type: "rematch",
          status: "accepted",
          gameId: newGameId,
        });
      }

      console.log(`✅ Rematch accepted: New game ${newGameId} created (colors swapped)`);
      console.log(`   Previous: White=${game.players.white?._id}, Black=${game.players.black?._id}`);
      console.log(`   New: White=${newGame.players.white}, Black=${newGame.players.black}`);

      // Notify both players with new gameId and their new colors
      const senderNewColor = isWhite ? "black" : "white";  // Sender swaps color
      const opponentNewColor = isWhite ? "white" : "black"; // Opponent swaps color

      // Emit to sender
      socket.emit("rematch:start", {
        gameId: newGameId,
        newColor: senderNewColor,
      });

      // Emit to opponent
      io.to(`user:${opponentId}`).emit("rematch:start", {
        gameId: newGameId,
        newColor: opponentNewColor,
      });

      // Both players should join the new game room
      const senderSockets = onlineUsers.get(senderId);
      const opponentSockets = onlineUsers.get(opponentId);

      if (senderSockets) {
        senderSockets.forEach((socketId) => {
          const s = io.sockets.sockets.get(socketId);
          if (s) {
            s.join(newGameId);
            if (!gameRoomSockets.has(newGameId)) {
              gameRoomSockets.set(newGameId, new Set());
            }
            gameRoomSockets.get(newGameId).add(socketId);
            if (!gameRoomUsers.has(newGameId)) {
              gameRoomUsers.set(newGameId, new Set());
            }
            gameRoomUsers.get(newGameId).add(senderId);
          }
        });
      }

      if (opponentSockets) {
        opponentSockets.forEach((socketId) => {
          const s = io.sockets.sockets.get(socketId);
          if (s) {
            s.join(newGameId);
            if (!gameRoomSockets.has(newGameId)) {
              gameRoomSockets.set(newGameId, new Set());
            }
            gameRoomSockets.get(newGameId).add(socketId);
            if (!gameRoomUsers.has(newGameId)) {
              gameRoomUsers.set(newGameId, new Set());
            }
            gameRoomUsers.get(newGameId).add(opponentId);
          }
        });
      }

      // Notify both players that they've joined the new game
      io.to(newGameId).emit("player-joined", {
        gameId: newGameId,
        userId: senderId,
      });
      io.to(newGameId).emit("player-joined", {
        gameId: newGameId,
        userId: opponentId,
      });
    } catch (err) {
      console.error("rematch:accept socket handler error:", err);
      socket.emit("rematch:error", {
        message: "Failed to accept rematch",
        error: err.message,
      });
    }
  });

  socket.on("disconnect", async () => {
    const userId = socket.data.userId;
    
    // Remove from matchmaking pool on disconnect
    if (userId) {
      removeFromMatchmaking(userId.toString());
    }

    // Remove socket from game rooms and reset ready state if game hasn't started
    for (const [gameId, socketSet] of gameRoomSockets.entries()) {
      if (socketSet.has(socket.id)) {
        socketSet.delete(socket.id);

        // Clean up userId tracking if this was the last socket for this user in this game
        if (userId) {
          const userSet = gameRoomUsers.get(gameId);
          if (userSet) {
            // Check if there are any other sockets for this userId in this game room
            let hasOtherSockets = false;
            if (socketSet.size > 0) {
              for (const otherSocketId of socketSet) {
                const otherSocket = io.sockets.sockets.get(otherSocketId);
                if (
                  otherSocket &&
                  otherSocket.data.userId &&
                  otherSocket.data.userId.toString() === userId.toString()
                ) {
                  hasOtherSockets = true;
                  break;
                }
              }
            }

            // Only remove userId if no other sockets for this user remain
            if (!hasOtherSockets) {
              userSet.delete(userId.toString());
              if (userSet.size === 0) {
                gameRoomUsers.delete(gameId);
              }
            }
          }
        }

        // If this was the last socket for a user in this game and game hasn't started, reset ready state
        if (socketSet.size > 0) {
          try {
            const Game = require("./models/Game");
            const game = await Game.findOne({ gameId }).lean();
            const gameHasStarted = game && game.moves && game.moves.length > 0;

            // Only reset ready state if game hasn't started
            if (!gameHasStarted && gameReadyState.has(gameId)) {
              gameReadyState.delete(gameId);
              console.log(
                `🔄 Reset ready state for game ${gameId} due to disconnect (game not started)`
              );
              io.to(gameId).emit("ready:reset", { gameId });
            }
          } catch (err) {
            console.error("Error checking game state on disconnect:", err);
          }
        }

        // Clean up empty game room
        if (socketSet.size === 0) {
          gameRoomSockets.delete(gameId);
        }
      }
    }

    if (userId && onlineUsers.has(userId)) {
      const sockets = onlineUsers.get(userId);
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);

        // Last connection for this user closed -> mark offline, end any active games, and notify friends / opponents
        try {
          await User.findByIdAndUpdate(userId, {
            status: "offline",
            lastActive: new Date(),
          }).exec();

          const userDoc = await User.findById(userId).select("friends").lean();

          // Immediately end any active games this user is part of and award win to opponent
          const activeGames = await Game.find({
            status: "active",
            $or: [{ "players.white": userId }, { "players.black": userId }],
          }).populate("players.white players.black");

          for (const game of activeGames) {
            // Let the opponent know a player disconnected in this game
            io.to(game.gameId).emit("player-disconnected", {
              gameId: game.gameId,
              userId,
            });

            // Skip auto-ending games that haven't started yet (no moves made)
            const gameHasMoves =
              Array.isArray(game.moves) && game.moves.length > 0;
            if (!gameHasMoves) {
              console.log(
                `⏸️ Skipping auto-end for game ${game.gameId} (no moves made yet)`
              );
              continue;
            }

            let winnerColor = null;
            if (
              game.players.white &&
              game.players.white._id.toString() === userId.toString()
            ) {
              // White disconnected -> black wins
              if (game.players.black) winnerColor = "black";
            } else if (
              game.players.black &&
              game.players.black._id.toString() === userId.toString()
            ) {
              // Black disconnected -> white wins
              if (game.players.white) winnerColor = "white";
            }

            // If for some reason there is no opponent (e.g., friend challenge not fully joined),
            // just mark game as abandoned.
            if (!winnerColor) {
              game.status = "completed";
              game.result = {
                winner: null,
                reason: "disconnect",
              };
            } else {
              game.status = "completed";
              game.result = {
                winner: winnerColor,
                reason: "disconnect",
              };
            }

            await game.save();

            // ✅ SAFE: Trigger review generation after game completion (async, non-blocking)
            // COPY EXACT FLOW FROM /end ENDPOINT (timeout handler) - DO NOT CHANGE
            try {
              const { triggerReviewGeneration } = require("./utils/game-review/game-completion-hook");
              triggerReviewGeneration(game.gameId);
            } catch (error) {
              // Don't fail game completion if review hook fails
              console.error(`[GameReview] Error triggering review generation hook:`, error);
            }

            // Update stats similarly to /api/games/:gameId/end
            const gameTime = Date.now() - game.createdAt.getTime();

            if (game.players.white) {
              const whiteStats = await Stats.findOne({
                user: game.players.white._id,
              });
              if (whiteStats) {
                const whiteResult =
                  game.result.winner === "white"
                    ? "win"
                    : game.result.winner === "black"
                    ? "loss"
                    : "draw";
                await whiteStats.updateAfterGame(
                  game.type,
                  whiteResult,
                  gameTime
                );
              }
            }

            if (game.players.black && game.type !== "bot") {
              const blackStats = await Stats.findOne({
                user: game.players.black._id,
              });
              if (blackStats) {
                const blackResult =
                  game.result.winner === "black"
                    ? "win"
                    : game.result.winner === "white"
                    ? "loss"
                    : "draw";
                await blackStats.updateAfterGame(
                  game.type,
                  blackResult,
                  gameTime
                );
              }
            }

            // Reset both players' user.status to "online" (they may come back later)
            if (game.players.white) {
              await User.findByIdAndUpdate(game.players.white._id, {
                status: "online",
              });
            }
            if (game.players.black && game.type !== "bot") {
              await User.findByIdAndUpdate(game.players.black._id, {
                status: "online",
              });
            }

            // Update Glicko-2 ratings
            const { updateGameRatings } = require("./services/updateGameRatings");
            await updateGameRatings(game, io);

            // Notify both players (and observers) that the game ended
            io.to(game.gameId).emit("game-ended", {
              gameId: game.gameId,
              result: game.result,
            });
          }

          if (userDoc?.friends?.length) {
            userDoc.friends.forEach((friendId) => {
              io.to(`user:${friendId.toString()}`).emit("presence:update", {
                userId,
                status: "offline",
              });
            });
          }
        } catch (err) {
          console.error("Presence disconnect error:", err);
        }
      } else {
        onlineUsers.set(userId, sockets);
      }
    }
    console.log("User disconnected:", socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: "Something went wrong!",
    error:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal server error",
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

const PORT = process.env.PORT || 5050;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, io };

// ---------------------------------------------------------------------------
// 🔁 Housekeeping: clean up stale invitations / games every 12 hours
// ---------------------------------------------------------------------------
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

async function cleanupExpiredInvitesAndGames() {
  const now = new Date();
  console.log(
    "🧹 Running scheduled cleanup for expired invitations/games:",
    now.toISOString()
  );

  try {
    // 1) Mark any still-pending invitations past expiresAt as "expired"
    const staleInvites = await GameInvitation.find({
      status: "pending",
      expiresAt: { $lt: now },
    }).lean();

    if (staleInvites.length > 0) {
      const tokens = staleInvites.map((inv) => inv.token);
      await GameInvitation.updateMany(
        { token: { $in: tokens } },
        { $set: { status: "expired" } }
      );
      console.log(`🧹 Marked ${staleInvites.length} invitations as expired`);
    }

    // 2) For any invitations we just expired (and any already expired),
    //    mark their associated games as "abandoned" if still active.
    const invitationsWithGames = await GameInvitation.find({
      status: "expired",
      gameId: { $ne: null },
    }).lean();

    if (invitationsWithGames.length > 0) {
      const gameIds = invitationsWithGames.map((inv) => inv.gameId);
      const result = await Game.updateMany(
        { gameId: { $in: gameIds }, status: "active" },
        { $set: { status: "abandoned" } }
      );
      if (result.modifiedCount) {
        console.log(
          `🧹 Marked ${result.modifiedCount} games as abandoned due to expired invites`
        );
      }
    }

    // Note: GameInvitation documents themselves have a TTL index on expiresAt,
    // so MongoDB will physically remove them automatically. This cron job
    // focuses on keeping statuses and related game records consistent.
  } catch (err) {
    console.error("❌ Cleanup job error:", err);
  }
}

setInterval(cleanupExpiredInvitesAndGames, TWELVE_HOURS_MS);

// ---------------------------------------------------------------------------
// 🗑️ Daily Cron Job: Anonymize accounts with pending_deletion (Hard Purge)
// ---------------------------------------------------------------------------
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const { anonymizeUser } = require("./utils/anonymizeUser");

async function deletePendingAccounts() {
  const now = new Date();
  console.log(
    "🗑️ Running daily account anonymization job:",
    now.toISOString()
  );

  try {
    // Find all users with pending_deletion status where deletionDate has passed
    const usersToAnonymize = await User.find({
      accountStatus: "pending_deletion",
      deletionDate: { $lt: now },
      isDeleted: { $ne: true }, // Don't process already anonymized accounts
    }).lean();

    if (usersToAnonymize.length === 0) {
      console.log("🗑️ No accounts to anonymize");
      return;
    }

    console.log(`🗑️ Found ${usersToAnonymize.length} accounts to anonymize`);

    for (const user of usersToAnonymize) {
      try {
        // Use anonymization function instead of hard delete
        // This preserves userId for foreign keys in Game, MoveHistory, etc.
        await anonymizeUser(user._id);
      } catch (error) {
        console.error(`❌ Error anonymizing account ${user._id}:`, error);
      }
    }

    console.log(`✅ Account anonymization job completed. Processed ${usersToAnonymize.length} accounts.`);
  } catch (err) {
    console.error("❌ Account anonymization job error:", err);
  }
}

// Run daily at midnight (or adjust as needed)
// For now, run every 24 hours from server start
setInterval(deletePendingAccounts, ONE_DAY_MS);

// Also run immediately on server start (for testing/development)
// Comment this out in production if you only want it to run on schedule
if (process.env.NODE_ENV === "development") {
  console.log("🔧 Development mode: Running account deletion check on startup");
  setTimeout(() => {
    deletePendingAccounts();
  }, 5000); // Wait 5 seconds after server starts
}
