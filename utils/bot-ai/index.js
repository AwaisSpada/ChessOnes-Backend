module.exports = {
  ...require("./profile"),
  ...require("./service"),
  ...require("./difficultyMapper"),
  configureEngineForBot: require("./engineConfigurator").configureEngineForBot,
};
