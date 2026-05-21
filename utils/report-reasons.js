const REPORT_REASON_IDS = new Set([
  "verbal_abuse",
  "hate_speech",
  "violence_threats",
  "sexual_harassment",
  "unsolicited_harassment",
  "engine_assistance",
  "collusion",
  "sandbagging",
  "bot_fake_account",
  "inappropriate_username",
  "inappropriate_avatar",
  "spamming",
  "other",
]);

const REASON_TO_CATEGORY = {
  verbal_abuse: "abuse",
  hate_speech: "abuse",
  violence_threats: "abuse",
  sexual_harassment: "abuse",
  unsolicited_harassment: "abuse",
  engine_assistance: "fair_play",
  collusion: "fair_play",
  sandbagging: "fair_play",
  bot_fake_account: "account_profile",
  inappropriate_username: "account_profile",
  inappropriate_avatar: "account_profile",
  spamming: "account_profile",
  other: "other",
};

function isValidReportReason(reasonId, category) {
  if (!REPORT_REASON_IDS.has(reasonId)) return false;
  return REASON_TO_CATEGORY[reasonId] === category;
}

const CATEGORY_LABELS = {
  abuse: "Abuse",
  fair_play: "Fair play",
  account_profile: "Account / profile",
  other: "Other",
};

const REASON_LABELS = {
  verbal_abuse: "Verbal abuse / cursing / trolling",
  hate_speech: "Hate speech",
  violence_threats: "Violence / threats",
  sexual_harassment: "Sexual harassment",
  unsolicited_harassment: "Unsolicited messages / harassment",
  engine_assistance: "Engine / computer assistance",
  collusion: "Collusion / pre-arranged results",
  sandbagging: "Sandbagging / rating manipulation",
  bot_fake_account: "Suspected bot or fake account",
  inappropriate_username: "Inappropriate username",
  inappropriate_avatar: "Inappropriate avatar or profile content",
  spamming: "Spamming",
  other: "Other",
};

function getCategoryLabel(category) {
  return CATEGORY_LABELS[category] || category;
}

function getReasonLabel(reasonId) {
  return REASON_LABELS[reasonId] || reasonId;
}

module.exports = {
  REPORT_REASON_IDS,
  REASON_TO_CATEGORY,
  CATEGORY_LABELS,
  REASON_LABELS,
  isValidReportReason,
  getCategoryLabel,
  getReasonLabel,
};
