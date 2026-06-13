const REPLY_PREFIX = "__REPLY__";
const REPLY_SUFFIX = "__END_REPLY__";

function previewMessengerBody(body) {
  if (!body || typeof body !== "string") return "";

  if (!body.startsWith(REPLY_PREFIX)) {
    return body;
  }

  const endIndex = body.indexOf(REPLY_SUFFIX);
  if (endIndex !== -1) {
    const text = body.slice(endIndex + REPLY_SUFFIX.length).replace(/^\n/, "");
    return text || body;
  }

  const newlineIndex = body.indexOf("\n");
  if (newlineIndex !== -1) {
    return body.slice(newlineIndex + 1);
  }

  return body;
}

module.exports = { previewMessengerBody };
