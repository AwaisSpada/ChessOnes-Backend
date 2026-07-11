const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const MessengerConversation = require("../models/MessengerConversation");
const MessengerMessage = require("../models/MessengerMessage");
const { usersAreBlocked } = require("../utils/user-blocks");
const { encrypt, decrypt } = require("../utils/messageCrypto");
const { previewMessengerBody } = require("../utils/messengerPreview");

const router = express.Router();

const MAX_BODY = 2000;
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

function requireMessengerTerms(req, res, next) {
  if (req.user?.hasAcceptedMessengerTerms === true) {
    return next();
  }
  return res.status(403).json({
    success: false,
    code: "MESSENGER_TERMS_REQUIRED",
    message: "Please accept Messenger terms before using messaging.",
  });
}

const messengerAuth = [auth, requireMessengerTerms];

/** Any registered user except self; blocked pairs cannot message. */
async function canMessagePeer(userId, peerId) {
  if (!mongoose.Types.ObjectId.isValid(peerId)) return false;
  const myStr = userId.toString();
  const peerStr = peerId.toString();
  if (peerStr === myStr) return false;
  if (await usersAreBlocked(userId, peerId)) return false;
  const peer = await User.findById(peerId).select("_id").lean();
  return !!peer;
}

function viewerIsUserA(conv, viewerId) {
  return conv.userA.toString() === viewerId.toString();
}

function unreadForViewer(conv, viewerId) {
  const vid = viewerId.toString();
  if (!conv.lastMessageAt || !conv.lastMessageSenderId) return false;
  const clearedAt = historyClearedAtForViewer(conv, viewerId);
  if (clearedAt && new Date(conv.lastMessageAt) <= clearedAt) return false;
  if (conv.lastMessageSenderId.toString() === vid) return false;
  const isA = viewerIsUserA(conv, viewerId);
  const readAt = isA ? conv.lastReadAtUserA : conv.lastReadAtUserB;
  if (!readAt) return true;
  return new Date(conv.lastMessageAt) > new Date(readAt);
}

function archivedForViewer(conv, viewerId) {
  const isA = viewerIsUserA(conv, viewerId);
  return isA ? !!conv.archivedForUserA : !!conv.archivedForUserB;
}

function deletedForViewer(conv, viewerId) {
  const isA = viewerIsUserA(conv, viewerId);
  return isA ? !!conv.deletedForUserA : !!conv.deletedForUserB;
}

function setArchivedForViewer(conv, viewerId, value) {
  if (viewerIsUserA(conv, viewerId)) {
    conv.archivedForUserA = value;
  } else {
    conv.archivedForUserB = value;
  }
}

function clearDeletedFlags(conv) {
  conv.deletedForUserA = false;
  conv.deletedForUserB = false;
}

function historyClearedAtForViewer(conv, viewerId) {
  const isA = viewerIsUserA(conv, viewerId);
  const at = isA ? conv.historyClearedAtUserA : conv.historyClearedAtUserB;
  return at ? new Date(at) : null;
}

function setHistoryClearedAtForViewer(conv, viewerId, when) {
  if (viewerIsUserA(conv, viewerId)) {
    conv.historyClearedAtUserA = when;
  } else {
    conv.historyClearedAtUserB = when;
  }
}

async function refreshConversationPreview(conv) {
  // Only consider live (non-soft-deleted) messages for the inbox preview so
  // both participants see the chat as if the deleted message never happened.
  const last = await MessengerMessage.findOne({
    conversation: conv._id,
    deletedAt: null,
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!last) {
    conv.lastMessageAt = null;
    conv.lastMessageSnippet = "";
    conv.lastMessageSenderId = null;
  } else {
    const plain = decrypt(last.body || "");
    conv.lastMessageAt = last.createdAt || new Date();
    // Snippet is stored encrypted; decrypt on read in the inbox endpoint.
    conv.lastMessageSnippet = encrypt(previewMessengerBody(plain || "").slice(0, 160));
    conv.lastMessageSenderId = last.sender;
  }
  await conv.save();
}

async function getFriendConversation(myId, peerId) {
  const [ua, ub] = MessengerConversation.orderParticipantIds(myId, peerId);
  return MessengerConversation.findOne({ userA: ua, userB: ub });
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
router.get("/unread-count", messengerAuth, async (req, res) => {
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
      if (deletedForViewer(c, myId)) continue;
      if (archivedForViewer(c, myId)) continue;
      if (!c.lastMessageAt) continue;
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
router.get("/inbox", messengerAuth, async (req, res) => {
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
    const peerById = new Map(friends.map((f) => [f._id.toString(), f]));

    const convs = await MessengerConversation.find({
      $or: [{ userA: myId }, { userB: myId }],
    }).lean();

    const missingPeerIds = new Set();
    for (const c of convs) {
      const other =
        c.userA.toString() === myId.toString() ? c.userB : c.userA;
      const pid = other.toString();
      if (!peerById.has(pid)) missingPeerIds.add(pid);
    }
    if (missingPeerIds.size > 0) {
      const extras = await User.find({
        _id: { $in: [...missingPeerIds] },
      })
        .select("username fullName avatar status rating country")
        .lean();
      for (const u of extras) {
        peerById.set(u._id.toString(), u);
      }
    }

    const rows = [];

    for (const c of convs) {
      if (!c.lastMessageAt) continue;
      if (deletedForViewer(c, myId)) continue;
      const clearedAt = historyClearedAtForViewer(c, myId);
      if (clearedAt && new Date(c.lastMessageAt) <= clearedAt) continue;

      const other =
        c.userA.toString() === myId.toString() ? c.userB : c.userA;
      const pid = other.toString();
      if (!(await canMessagePeer(myId, pid))) continue;
      const f = peerById.get(pid);
      if (!f) continue;

      rows.push({
        peerId: pid,
        conversationId: c._id.toString(),
        name: f.fullName || f.username || "Player",
        avatar: f.avatar || undefined,
        country: f.country || undefined,
        lastMessage: previewMessengerBody(decrypt(c.lastMessageSnippet || "")),
        lastMessageAt: new Date(c.lastMessageAt).toISOString(),
        hasUnread: unreadForViewer(c, myId),
        archived: archivedForViewer(c, myId),
      });
    }

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
router.get("/peers/:peerId/messages", messengerAuth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(peerId)) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    if (peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }

    const ok = await canMessagePeer(myId, peerId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "Cannot message this user",
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

    if (deletedForViewer(conv, myId)) {
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
    // Hide soft-deleted messages from the regular UI for both participants;
    // they remain visible only in the admin investigation tool.
    const q = { conversation: conv._id, deletedAt: null };
    const clearedAt = historyClearedAtForViewer(conv, myId);
    if (clearedAt) {
      q.createdAt = { $gt: clearedAt };
    }
    if (before && mongoose.Types.ObjectId.isValid(before)) {
      const anchor = await MessengerMessage.findById(before).select("createdAt").lean();
      if (anchor?.createdAt) {
        q.createdAt = { ...(q.createdAt || {}), $lt: anchor.createdAt };
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
      body: decrypt(m.body || ""),
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
router.post("/peers/:peerId/read", messengerAuth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(peerId) || peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    const ok = await canMessagePeer(myId, peerId);
    if (!ok) {
      return res.status(403).json({ success: false, message: "Cannot message this user" });
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
router.post("/peers/:peerId/messages", messengerAuth, async (req, res) => {
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

    const ok = await canMessagePeer(myId, peerId);
    if (!ok) {
      return res.status(403).json({
        success: false,
        message: "Cannot message this user",
      });
    }

    const conv = await MessengerConversation.findOrCreateForUsers(myId, peerId);
    clearDeletedFlags(conv);

    // Model's pre-validate hook AES-256-GCM encrypts `body` before insert.
    const msg = await MessengerMessage.create({
      conversation: conv._id,
      sender: myId,
      body: trimmed,
    });

    conv.lastMessageAt = msg.createdAt || new Date();
    conv.lastMessageSnippet = encrypt(previewMessengerBody(trimmed).slice(0, 160));
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

// @route   POST /api/messenger/peers/:peerId/archive
// @body    { archived: boolean }
router.post("/peers/:peerId/archive", messengerAuth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(peerId) || peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    const ok = await canMessagePeer(myId, peerId);
    if (!ok) {
      return res.status(403).json({ success: false, message: "Cannot message this user" });
    }
    const archived = !!req.body?.archived;
    const conv = await getFriendConversation(myId, peerId);
    if (!conv) {
      return res.json({ success: true, data: { archived } });
    }
    setArchivedForViewer(conv, myId, archived);
    await conv.save();
    return res.json({ success: true, data: { archived } });
  } catch (error) {
    console.error("[Messenger] archive error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// @route   POST /api/messenger/peers/:peerId/unread
// @desc    Mark conversation unread for current user
router.post("/peers/:peerId/unread", messengerAuth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(peerId) || peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    const ok = await canMessagePeer(myId, peerId);
    if (!ok) {
      return res.status(403).json({ success: false, message: "Cannot message this user" });
    }
    const conv = await getFriendConversation(myId, peerId);
    if (!conv || !conv.lastMessageAt) {
      return res.json({ success: true, data: { ok: true } });
    }
    if (viewerIsUserA(conv, myId)) {
      conv.lastReadAtUserA = null;
    } else {
      conv.lastReadAtUserB = null;
    }
    await conv.save();
    return res.json({ success: true, data: { ok: true } });
  } catch (error) {
    console.error("[Messenger] unread error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// @route   DELETE /api/messenger/peers/:peerId/conversation
// @desc    Hide chat for current user only (peer still sees thread)
router.delete("/peers/:peerId/conversation", messengerAuth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { peerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(peerId) || peerId === myId.toString()) {
      return res.status(400).json({ success: false, message: "Invalid peer" });
    }
    const ok = await canMessagePeer(myId, peerId);
    if (!ok) {
      return res.status(403).json({ success: false, message: "Cannot message this user" });
    }
    let conv = await getFriendConversation(myId, peerId);
    if (!conv) {
      conv = await MessengerConversation.findOrCreateForUsers(myId, peerId);
    }
    const now = new Date();
    setHistoryClearedAtForViewer(conv, myId, now);
    if (viewerIsUserA(conv, myId)) {
      conv.deletedForUserA = true;
    } else {
      conv.deletedForUserB = true;
    }
    await conv.save();
    return res.json({ success: true, data: { ok: true } });
  } catch (error) {
    console.error("[Messenger] delete conversation error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// @route   DELETE /api/messenger/messages/:messageId
router.delete("/messages/:messageId", messengerAuth, async (req, res) => {
  try {
    const myId = req.user._id;
    const { messageId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: "Invalid message" });
    }
    const msg = await MessengerMessage.findById(messageId);
    if (!msg) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }
    const conv = await MessengerConversation.findById(msg.conversation);
    if (!conv) {
      return res.status(404).json({ success: false, message: "Conversation not found" });
    }
    const peerId =
      conv.userA.toString() === myId.toString()
        ? conv.userB.toString()
        : conv.userA.toString();
    const ok = await canMessagePeer(myId, peerId);
    if (!ok) {
      return res.status(403).json({ success: false, message: "Not allowed" });
    }
    if (msg.sender.toString() !== myId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own messages",
      });
    }
    if (!msg.deletedAt) {
      // Soft-delete so the row + ciphertext stay for moderator investigation
      // (per Privacy Policy §11) but both participants stop seeing it.
      msg.deletedAt = new Date();
      msg.deletedBy = myId;
      await msg.save();
    }
    await refreshConversationPreview(conv);
    const payload = {
      type: "message-deleted",
      messageId: messageId.toString(),
      conversationId: conv._id.toString(),
    };
    emitMessengerToUser(req, peerId, { ...payload, inboxPeerId: myId.toString() });
    emitMessengerToUser(req, myId.toString(), { ...payload, inboxPeerId: peerId });
    return res.json({ success: true, data: { ok: true, conversationId: conv._id.toString() } });
  } catch (error) {
    console.error("[Messenger] delete message error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
