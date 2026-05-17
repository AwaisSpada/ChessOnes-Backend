const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const MessengerConversation = require("../models/MessengerConversation");
const MessengerMessage = require("../models/MessengerMessage");

const router = express.Router();

const MAX_BODY = 2000;
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

async function areFriends(userId, peerId) {
  const user = await User.findById(userId).select("friends").lean();
  if (!user?.friends?.length) return false;
  const p = peerId.toString();
  return user.friends.some((fid) => fid.toString() === p);
}

function unreadForViewer(conv, viewerId) {
  const vid = viewerId.toString();
  if (!conv.lastMessageAt || !conv.lastMessageSenderId) return false;
  if (conv.lastMessageSenderId.toString() === vid) return false;
  const isA = conv.userA.toString() === vid;
  const readAt = isA ? conv.lastReadAtUserA : conv.lastReadAtUserB;
  if (!readAt) return true;
  return new Date(conv.lastMessageAt) > new Date(readAt);
}

/** @param {import("express").Request} req */
function emitMessengerToUser(req, userId, payload) {
  try {
    const io = req.app.get("io");
    if (!io) return;
    io.to(`user:${userId}`).emit("messenger:message", payload);
  } catch (e) {
    console.error("[Messenger] socket emit error:", e);
  }
}

// @route   GET /api/messenger/unread-count
// @desc    Number of friend conversations with unread incoming messages
// @access  Private
router.get("/unread-count", auth, async (req, res) => {
  try {
    const myId = req.user._id;
    const user = await User.findById(myId).select("friends").lean();
    const friendIds = user?.friends || [];
    if (!friendIds.length) {
      return res.json({ success: true, data: { unreadConversationCount: 0 } });
    }

    const convs = await MessengerConversation.find({
      $or: [
        { userA: myId, userB: { $in: friendIds } },
        { userB: myId, userA: { $in: friendIds } },
      ],
    }).lean();

    let n = 0;
    for (const c of convs) {
      if (unreadForViewer(c, myId)) n += 1;
    }

    return res.json({ success: true, data: { unreadConversationCount: n } });
  } catch (error) {
    console.error("[Messenger] unread-count error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// @route   GET /api/messenger/inbox
// @desc    Friends list with last DM preview (DB-backed)
// @access  Private
router.get("/inbox", auth, async (req, res) => {
  try {
    const myId = req.user._id;
    const user = await User.findById(myId)
      .populate(
        "friends",
        "username fullName avatar status rating ratings puzzleRating country"
      )
      .select("friends")
      .lean();

    const friends = user?.friends || [];
    const friendIds = friends.map((f) => f._id);

    const convs = await MessengerConversation.find({
      $or: [
        { userA: myId, userB: { $in: friendIds } },
        { userB: myId, userA: { $in: friendIds } },
      ],
    }).lean();

    const convByPeer = new Map();
    for (const c of convs) {
      const other =
        c.userA.toString() === myId.toString() ? c.userB : c.userA;
      convByPeer.set(other.toString(), c);
    }

    const rows = friends.map((f) => {
      const pid = f._id.toString();
      const c = convByPeer.get(pid);
      const hasUnread = c ? unreadForViewer(c, myId) : false;
      return {
        peerId: pid,
        conversationId: c?._id?.toString() ?? null,
        name: f.fullName || f.username || "Player",
        avatar: f.avatar || undefined,
        lastMessage: c?.lastMessageSnippet || "",
        lastMessageAt: c?.lastMessageAt
          ? new Date(c.lastMessageAt).toISOString()
          : null,
        hasUnread,
      };
    });

    rows.sort((a, b) => {
      const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      if (ta && tb && ta !== tb) return tb - ta;
      if (ta && !tb) return -1;
      if (!ta && tb) return 1;
      return a.name.localeCompare(b.name);
    });

    return res.json({ success: true, data: { conversations: rows } });
  } catch (error) {
    console.error("[Messenger] inbox error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// @route   GET /api/messenger/peers/:peerId/messages
// @access  Private (marks thread read for current user)
router.get("/peers/:peerId/messages", auth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(peerId)) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    if (peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }

    const ok = await areFriends(myId, peerId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "You can only message friends",
      });
    }

    const [ua, ub] = MessengerConversation.orderParticipantIds(myId, peerId);
    const conv = await MessengerConversation.findOne({
      userA: ua,
      userB: ub,
    });

    if (!conv) {
      return res.json({ success: true, data: { messages: [] } });
    }

    const now = new Date();
    if (ua.toString() === myId.toString()) {
      conv.lastReadAtUserA = now;
    } else {
      conv.lastReadAtUserB = now;
    }
    await conv.save();

    const limit = Math.min(
      parseInt(req.query.limit, 10) || PAGE_SIZE_DEFAULT,
      PAGE_SIZE_MAX
    );
    const before = req.query.before;
    const q = { conversation: conv._id };
    if (before && mongoose.Types.ObjectId.isValid(before)) {
      const anchor = await MessengerMessage.findById(before).select("createdAt").lean();
      if (anchor?.createdAt) {
        q.createdAt = { $lt: anchor.createdAt };
      }
    }

    const raw = await MessengerMessage.find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const chronological = [...raw].reverse();
    const messages = chronological.map((m) => ({
      id: m._id.toString(),
      senderId: m.sender.toString(),
      body: m.body,
      createdAt: new Date(m.createdAt).getTime(),
    }));

    return res.json({ success: true, data: { messages } });
  } catch (error) {
    console.error("[Messenger] list messages error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// @route   POST /api/messenger/peers/:peerId/read
// @desc    Mark conversation read (e.g. while viewing live messages)
// @access  Private
router.post("/peers/:peerId/read", auth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(peerId) || peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    const ok = await areFriends(myId, peerId);
    if (!ok) {
      return res.status(403).json({ success: false, message: "You can only message friends" });
    }
    const [ua, ub] = MessengerConversation.orderParticipantIds(myId, peerId);
    const conv = await MessengerConversation.findOne({ userA: ua, userB: ub });
    if (!conv) {
      return res.json({ success: true, data: { ok: true } });
    }
    const now = new Date();
    if (ua.toString() === myId.toString()) {
      conv.lastReadAtUserA = now;
    } else {
      conv.lastReadAtUserB = now;
    }
    await conv.save();
    return res.json({ success: true, data: { ok: true } });
  } catch (error) {
    console.error("[Messenger] read error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// @route   POST /api/messenger/peers/:peerId/messages
// @access  Private
router.post("/peers/:peerId/messages", auth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    const bodyText = typeof req.body?.body === "string" ? req.body.body : "";

    if (!mongoose.Types.ObjectId.isValid(peerId)) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    if (peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }

    const trimmed = bodyText.trim();
    if (!trimmed) {
      return res.status(400).json({ success: false, message: "Message is empty" });
    }
    if (trimmed.length > MAX_BODY) {
      return res.status(400).json({ success: false, message: "Message too long" });
    }

    const ok = await areFriends(myId, peerId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "You can only message friends",
      });
    }

    const conv = await MessengerConversation.findOrCreateForUsers(myId, peerId);

    const msg = await MessengerMessage.create({
      conversation: conv._id,
      sender: myId,
      body: trimmed,
    });

    conv.lastMessageAt = msg.createdAt || new Date();
    conv.lastMessageSnippet = trimmed.slice(0, 160);
    conv.lastMessageSenderId = myId;
    await conv.save();

    const sender = await User.findById(myId)
      .select("fullName username avatar")
      .lean();
    const senderName =
      sender?.fullName || sender?.username || "Someone";
    const senderAvatar = sender?.avatar || "";

    const createdIso = (msg.createdAt || new Date()).toISOString();
    const base = {
      conversationId: conv._id.toString(),
      authorId: myId.toString(),
      body: trimmed,
      createdAt: createdIso,
      messageId: msg._id.toString(),
      senderName,
      senderAvatar,
    };

    emitMessengerToUser(req, peerId, { ...base, inboxPeerId: myId.toString() });
    emitMessengerToUser(req, myId.toString(), { ...base, inboxPeerId: peerId });

    return res.json({
      success: true,
      data: {
        conversationId: conv._id.toString(),
        message: {
          id: msg._id.toString(),
          senderId: myId.toString(),
          body: trimmed,
          createdAt: new Date(msg.createdAt || Date.now()).getTime(),
        },
      },
    });
  } catch (error) {
    console.error("[Messenger] send error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
