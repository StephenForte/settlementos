// Config for the second local chain, simulating Polygon Amoy.
// Run: npm run chain:polygon  (port 8546, chainId 31338)
const base = require("./hardhat.config.cjs");

module.exports = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: { chainId: 31338 },
    localhost: { url: "http://127.0.0.1:8546", chainId: 31338 },
  },
};
